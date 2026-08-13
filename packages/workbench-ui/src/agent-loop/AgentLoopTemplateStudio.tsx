import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Bot, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import {
  validateTemplateDefinition,
  validateTemplateDefinitionV3,
  type ExecutionProfileDefinitionV3,
  type AgentCardDefinition,
  type TemplateDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import { AgentLoopAcpProfileSummary } from "./AgentLoopAcpProfileSummary";
import {
  AgentLoopMetaPanel,
  type AgentLoopMetaPanelController,
  type AgentLoopMetaTarget,
} from "./AgentLoopMetaPanel";
import {
  createAgentLoopTemplateDraftEditor,
  downloadAgentLoopTemplateExport,
  type AgentLoopTemplateDraftEditor,
  type AgentLoopTemplateImportPreview,
  type AgentLoopTemplateProfileRevisionOption,
  type AgentLoopTemplateStudioSurfaceController,
  type AgentLoopTemplateStudioDraft,
  type AgentLoopTemplateStudioTemplate,
  type AgentLoopTemplateStudioViewModel,
  type AgentLoopTemplateVersion,
} from "./agent-loop-template-studio-controller";

export type AgentLoopTemplateStudioProps = Readonly<{
  controller: AgentLoopTemplateStudioSurfaceController;
  /** Optional for isolated embedding; production composition always supplies it. */
  metaController?: AgentLoopMetaPanelController;
}>;

/**
 * The prototype-defined Template Index and unified Version/Draft Workspace.
 * Renderer state selects objects and explicit Meta targets; Runtime remains the
 * sole owner of Draft, Version, migration, import, and publish facts.
 */
export function AgentLoopTemplateStudio({ controller, metaController }: AgentLoopTemplateStudioProps) {
  const [view, setView] = useState<AgentLoopTemplateStudioViewModel>();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>();
  const [selectedTemplateVersionId, setSelectedTemplateVersionId] = useState<string>();
  const [editor, setEditor] = useState<AgentLoopTemplateDraftEditor>();
  const [versionWorkspaceOpen, setVersionWorkspaceOpen] = useState(false);
  const [migrationSource, setMigrationSource] = useState<AgentLoopTemplateVersion>();
  const [importPreview, setImportPreview] = useState<AgentLoopTemplateImportPreview>();
  const [actionKey, setActionKey] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [metaTargets, setMetaTargets] = useState<readonly AgentLoopMetaTarget[]>([templateMetaTarget()]);
  const [metaPanelOpen, setMetaPanelOpen] = useState(false);
  const [metaPanelWidth, setMetaPanelWidth] = useState(320);
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
    const visibleTemplates = next.templates.filter((template) => !template.archivedAt);
    const nextSelectedTemplateId = visibleTemplates.some((template) => template.templateId === current)
      ? current
      : visibleTemplates[0]?.templateId;
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

  const visibleTemplates = useMemo(
    () => view?.templates.filter((template) => !template.archivedAt) ?? [],
    [view?.templates],
  );
  const selected = useMemo(
    () => visibleTemplates.find((template) => template.templateId === selectedTemplateId) ?? visibleTemplates[0],
    [selectedTemplateId, visibleTemplates],
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
  const editorPublishReady = Boolean(editor?.templateDraftId
    && editor.revision !== undefined
    && persistedEditor
    && persistedEditor.revision === editor.revision
    && !editorDirty
    && templateSchemaVersion(editor.definitionText) === 3
    && controller.supportsAcpTemplateV3);
  const metaScope = editor?.templateDraftId && editor.revision !== undefined
    && templateSchemaVersion(editor.definitionText) === 3
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
    if (!controller.supportsAcpTemplateV3) {
      setError("acp_template_v3_command_not_registered");
      return;
    }
    const source = view?.templates.find((template) => template.slug === "deepsearch")?.currentVersion
      ?? view?.templates.find((template) => !template.archivedAt)?.currentVersion;
    if (!source || templateSchemaVersion(source.definitionText) !== 3) {
      setError("deepsearch_template_starter_not_found");
      return;
    }
    const nextEditor = createAgentLoopTemplateDraftEditor({
      title: "New Deepsearch Template",
      slug: "new-deepsearch-template",
      description: "Describe the research workflow you want Meta Agent to shape.",
      definitionText: source.definitionText,
    });
    void runAction("template.create", async () => {
      const saved = await controller.createDraft(nextEditor);
      setEditor(saved);
      setVersionWorkspaceOpen(false);
      setMigrationSource(undefined);
      setMetaTargets([templateMetaTarget()]);
    }, "Draft 已建立；现在可以直接让 Meta Agent 修订完整 Template。");
  }, [controller, runAction, view?.templates]);

  const editSelectedVersion = useCallback((template: AgentLoopTemplateStudioTemplate, version: AgentLoopTemplateVersion) => {
    if (templateSchemaVersion(version.definitionText) === 2) {
      setEditor(undefined);
      setVersionWorkspaceOpen(false);
      setMigrationSource(version);
      setMetaTargets([templateMetaTarget()]);
      setError(undefined);
      setNotice("schema v2 Version 保持只读；请显式选择 Host-issued ACP Profile revision 创建新 v3 Draft。");
      return;
    }
    const nextEditor = createAgentLoopTemplateDraftEditor({
      templateId: template.templateId,
      baseTemplateVersionId: version.templateVersionId,
      title: template.title,
      slug: template.slug,
      description: template.description,
      definitionText: version.definitionText,
    });
    void runAction(`template.revise:${version.templateVersionId}`, async () => {
      const saved = await controller.createDraft(nextEditor);
      setEditor(saved);
      setVersionWorkspaceOpen(false);
      setMigrationSource(undefined);
      setMetaTargets([templateMetaTarget()]);
    }, `已从不可变 Version v${version.version} 建立 Draft；Meta Agent 已绑定这个 Draft。`);
  }, [controller, runAction]);

  const openPersistedDraft = useCallback((draft: AgentLoopTemplateStudioDraft) => {
    setEditor(editorFromStudioDraft(draft));
    setVersionWorkspaceOpen(false);
    setMigrationSource(undefined);
    setMetaTargets([templateMetaTarget()]);
  }, []);

  const saveEditor = useCallback(() => {
    if (!editor) return;
    if (templateSchemaVersion(editor.definitionText) !== 3 || !controller.supportsAcpTemplateV3) {
      setError("acp_template_v3_command_not_registered");
      return;
    }
    void runAction("template.save", async () => {
      const saved = editor.templateDraftId
        ? await controller.saveDraft(editor)
        : await controller.createDraft(editor);
      setEditor(saved);
    }, "Draft 已保存；发布会创建新的不可变 Version。");
  }, [controller, editor, runAction]);

  const publishEditor = useCallback(() => {
    if (!editor) return;
    if (templateSchemaVersion(editor.definitionText) !== 3 || !controller.supportsAcpTemplateV3) {
      setError("acp_template_v3_command_not_registered");
      return;
    }
    void runAction("template.publish", async () => {
      await controller.publishDraft(editor);
      setEditor(undefined);
      setVersionWorkspaceOpen(false);
    }, "已发布新的 Template Version；已有 Task 不会被改变。");
  }, [controller, editor, runAction]);

  const exportSelectedVersion = useCallback((version: AgentLoopTemplateVersion) => {
    if (!controller.exportVersion) return;
    void runAction(`template.export:${version.templateVersionId}`, async () => {
      downloadAgentLoopTemplateExport(await controller.exportVersion!(version.templateVersionId));
    }, "已导出所选不可变 Version。");
  }, [controller, runAction]);

  const archiveSelectedTemplate = useCallback(() => {
    if (!controller.archiveTemplate || !selectedDetail || selectedDetail.archivedAt) return;
    void runAction(`template.archive:${selectedDetail.templateId}:${selectedDetail.revision}`, async () => {
      await controller.archiveTemplate!(selectedDetail.templateId, selectedDetail.revision);
    }, "Template identity 已归档；不可变 Version 与已有 Task 保持不变。");
  }, [controller, runAction, selectedDetail]);

  const selectTemplate = useCallback((templateId: string) => {
    selectedTemplateIdRef.current = templateId;
    setSelectedTemplateId(templateId);
    setSelectedTemplateVersionId(undefined);
    setEditor(undefined);
    setVersionWorkspaceOpen(true);
    setMigrationSource(undefined);
    void refresh().catch((reason: unknown) => setError(messageFor(reason)));
  }, [refresh]);

  const returnToIndex = useCallback(() => {
    setEditor(undefined);
    setMigrationSource(undefined);
    setVersionWorkspaceOpen(false);
    setError(undefined);
    setNotice(undefined);
  }, []);

  const migrateVersion = useCallback((input: Readonly<{
    source: AgentLoopTemplateVersion;
    profileSelections: readonly Readonly<{ executionProfileId: string; profileRevisionId: string }>[];
  }>) => {
    const migrate = controller.migrateVersionToAcpV3;
    if (!migrate) return;
    void runAction(`template.migrate:${input.source.templateVersionId}`, async () => {
      const nextEditor = await migrate({
        sourceTemplateVersionId: input.source.templateVersionId,
        expectedSourceDefinitionHash: input.source.definitionHash,
        profileSelections: input.profileSelections,
      });
      setEditor(nextEditor);
      setMigrationSource(undefined);
    }, "已从不可变 v2 Version 创建新 ACP v3 Draft；源 Version 字节未改写。");
  }, [controller, runAction]);

  const previewFile = useCallback(async (file: File) => {
    if (!controller.previewImport) return;
    setActionKey("template.preview_import");
    setError(undefined);
    setNotice(undefined);
    try {
      const preview = await controller.previewImport({
        fileName: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      if (importPreview) controller.discardImportPreview?.(importPreview.importId);
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
    if (!controller.importPreview) return;
    void runAction(`template.import:${preview.importId}:${mode}`, async () => {
      await controller.importPreview!(preview.importId, mode);
      setImportPreview(undefined);
    }, mode === "create" ? "已从校验后的 package 创建 Template。" : "已导入新的不可变 Template Version。");
  }, [controller, runAction]);

  const cancelImport = useCallback(() => {
    if (importPreview) controller.discardImportPreview?.(importPreview.importId);
    setImportPreview(undefined);
  }, [controller, importPreview]);

  if (!editor && !migrationSource && !versionWorkspaceOpen) {
    return <section aria-label="AgentLoop Template Studio" className="awb-template-index">
      <header className="awb-template-index-head">
        <div><p className="awb-eyebrow">Template Index</p><h1>模板库</h1><p>查看 Version 与 Draft 的状态；点击进入统一 Template Workspace。</p></div>
        <div className="awb-actions">
          {controller.previewImport && controller.importPreview ? <><input
            accept=".yaml,.yml,.zip,application/yaml,text/yaml,application/zip"
            className="awb-visually-hidden"
            onChange={onImportFile}
            ref={inputRef}
            type="file"
          /><button className="awb-button awb-button-secondary" disabled={Boolean(actionKey)} onClick={() => inputRef.current?.click()} type="button">
            {actionKey === "template.preview_import" ? "校验 package…" : "导入"}
          </button></> : null}
          <button className="awb-button awb-button-primary" data-testid="template-create" disabled={!controller.supportsAcpTemplateV3 || Boolean(actionKey)} onClick={openNewDraft} type="button">＋ 用 Meta Agent 新建</button>
        </div>
      </header>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {importPreview ? <ImportPreview busy={Boolean(actionKey?.startsWith("template.import"))} onCancel={cancelImport} onImport={confirmImport} preview={importPreview} /> : null}
      <section aria-labelledby="published-template-title" className="awb-template-index-section">
        <header><div><h2 id="published-template-title">已发布模板</h2><p>不可变 Version；打开后仍使用统一工作台。</p></div><span>{visibleTemplates.length}</span></header>
        <div aria-label="Template 列表" className="awb-template-index-list">
          {visibleTemplates.length ? visibleTemplates.map((template) => <button
            className="awb-template-index-row"
            key={template.templateId}
            onClick={() => selectTemplate(template.templateId)}
            type="button"
          >
            <span className="awb-template-index-mark">{template.title.slice(0, 1).toUpperCase()}</span>
            <span><strong>{template.title}</strong><small>{template.description ?? "Template Workspace"}</small></span>
            <span><b>{template.currentVersion ? `v${template.currentVersion.version}` : "未发布"}</b><small>{template.archivedAt ? "已归档" : "不可变 Version"}</small></span>
            <span aria-hidden="true">→</span>
          </button>) : <Empty title="还没有 Template" detail="新建一个 ACP v3 Draft，或导入一个已经校验的 package。" />}
        </div>
      </section>
      <section aria-labelledby="template-drafts-title" className="awb-template-index-section">
        <header><div><h2 id="template-drafts-title">我的 Draft</h2><p>继续上次修订；对话与候选 Patch 都留在对应工作台。</p></div><span>{view?.drafts.length ?? 0}</span></header>
        <div className="awb-template-index-list">
          {view?.drafts.length ? view.drafts.map((draft) => <DraftIndexRow draft={draft} key={draft.templateDraftId} onOpen={() => openPersistedDraft(draft)} />) : <p className="awb-agent-loop-muted">尚无可继续编辑的 Draft。</p>}
        </div>
      </section>
    </section>;
  }

  return (
    <section
      aria-label="AgentLoop Template Studio"
      className={`awb-agent-loop-template-layout is-workspace ${editor ? "is-editing" : "is-version"} ${editor && metaController ? "has-meta-dock" : ""} ${metaPanelOpen ? "is-meta-open" : "is-meta-collapsed"}`}
      style={{ "--awb-template-meta-width": `${metaPanelWidth}px` } as CSSProperties}
    >
      {editor && metaController && metaScope && metaPanelOpen ? <AgentLoopMetaPanel
        controller={metaController}
        draftDirty={editorDirty}
        onClose={() => setMetaPanelOpen(false)}
        onCollapse={() => setMetaPanelOpen(false)}
        onDockChange={() => undefined}
        onPatchApplied={async () => {
          const next = await refresh();
          const updated = next?.drafts.find((draft) => draft.templateDraftId === metaScope.draftId);
          if (updated) setEditor(editorFromStudioDraft(updated));
        }}
        placement="docked"
        showViewControls={false}
        scope={metaScope}
        targets={metaTargets}
      /> : editor && metaController && metaScope ? <aside aria-label="Meta Agent launcher" className="awb-template-meta-launcher">
        <button aria-label="打开 Meta Agent 侧栏" data-testid="meta-panel-open" onClick={() => setMetaPanelOpen(true)} title="打开 Meta Agent 侧栏" type="button">
          <Bot aria-hidden="true" size={18} />
          <span>AI</span>
          <PanelLeftOpen aria-hidden="true" size={14} />
        </button>
      </aside> : null}

      {editor && metaController && metaScope && metaPanelOpen ? <HorizontalPaneResizer
        ariaLabel="调整 Meta Agent 侧栏宽度"
        max={480}
        min={280}
        onChange={setMetaPanelWidth}
        side="left"
        value={metaPanelWidth}
      /> : null}

      <section className="awb-agent-loop-template-canvas">
        {!editor ? <header className="awb-template-version-head">
          <div>
            <p className="awb-eyebrow">Template Workspace · {migrationSource ? "Migration" : `Version v${selectedVersion?.version ?? "—"}`}</p>
            <h1>{selected?.title ?? "Template Studio"}</h1>
            <p>{selected?.description ?? "Version 与 Draft 共用一份对象结构。"}</p>
          </div>
          <div className="awb-template-workspace-actions">
            {selectedVersion ? <span className="awb-status">已发布 v{selectedVersion.version} · 只读</span> : null}
            {selectedVersions.length > 1 ? <label className="awb-agent-loop-version-select">Version<select aria-label="选择 Template Version" disabled={Boolean(actionKey)} onChange={(event) => setSelectedTemplateVersionId(event.target.value)} value={effectiveSelectedVersionId ?? ""}>
              {selectedVersions.map((version) => <option key={version.templateVersionId} value={version.templateVersionId}>v{version.version}{version.templateVersionId === selectedDetail?.activeTemplateVersionId ? "（当前）" : ""}</option>)}
            </select></label> : null}
            <button
              className="awb-button awb-button-primary"
              disabled={!selected || !selectedVersion || Boolean(actionKey) || (templateSchemaVersion(selectedVersion.definitionText) === 2 && !controller.migrateVersionToAcpV3)}
              onClick={() => selected && selectedVersion && editSelectedVersion(selected, selectedVersion)}
              title={selectedVersion && templateSchemaVersion(selectedVersion.definitionText) === 2 && !controller.migrateVersionToAcpV3 ? "Runtime migration command not registered" : undefined}
              type="button"
            >{selectedVersion && templateSchemaVersion(selectedVersion.definitionText) === 2 ? "迁移到 ACP v3 Draft" : `基于 v${selectedVersion?.version ?? "—"} 开始修订`}</button>
            {controller.exportVersion ? <button className="awb-button awb-button-secondary" disabled={!selectedVersion || Boolean(actionKey)} onClick={() => selectedVersion && exportSelectedVersion(selectedVersion)} type="button">导出 v{selectedVersion?.version}</button> : null}
            {controller.archiveTemplate && selectedDetail && !selectedDetail.archivedAt ? <button className="awb-button awb-button-secondary" disabled={Boolean(actionKey)} onClick={archiveSelectedTemplate} type="button">归档 Template</button> : null}
            <button className="awb-button awb-button-secondary" onClick={returnToIndex} type="button">返回模板库</button>
          </div>
        </header> : null}

        {error ? <Notice tone="error">{error}</Notice> : null}
        {notice ? <Notice tone="success">{notice}</Notice> : null}

        {editor ? <EditorPanel
          busy={actionKey === "template.save" || actionKey === "template.publish"}
          editor={editor}
          profileOptions={view?.profileOptions ?? []}
          supportsAcpTemplateV3={controller.supportsAcpTemplateV3 === true}
          onCancel={returnToIndex}
          onChange={(patch) => setEditor((current) => current ? Object.freeze({ ...current, ...patch }) : current)}
          metaAvailable={Boolean(metaController && metaScope)}
          metaTargets={metaTargets}
          onMetaTargetsChange={setMetaTargets}
          onPublish={publishEditor}
          publishReady={editorPublishReady}
          onSave={saveEditor}
        /> : migrationSource ? <LegacyVersionMigration
          busy={actionKey === `template.migrate:${migrationSource.templateVersionId}`}
          canMigrate={Boolean(controller.migrateVersionToAcpV3)}
          key={migrationSource.templateVersionId}
          onCancel={() => setMigrationSource(undefined)}
          onMigrate={(profileSelections) => migrateVersion({ source: migrationSource, profileSelections })}
          profileOptions={view?.profileOptions ?? []}
          source={migrationSource}
        /> : <TemplateVersionWorkspace
          migrationCommandAvailable={Boolean(controller.migrateVersionToAcpV3)}
          profileOptions={view?.profileOptions ?? []}
          template={selected}
          version={selectedVersion}
        />}
      </section>
    </section>
  );
}

function TemplateVersionWorkspace({ migrationCommandAvailable, profileOptions, template, version }: Readonly<{
  migrationCommandAvailable: boolean;
  profileOptions: readonly AgentLoopTemplateProfileRevisionOption[];
  template?: AgentLoopTemplateStudioTemplate;
  version?: AgentLoopTemplateVersion;
}>) {
  const definition = version ? readTemplateDefinitionV3(version.definitionText) : undefined;
  if (!template || !version || !definition) return <TemplateVersionFacts
    migrationCommandAvailable={migrationCommandAvailable}
    template={template}
    version={version}
  />;
  const readOnlyEditor = createAgentLoopTemplateDraftEditor({
    templateId: template.templateId,
    baseTemplateVersionId: version.templateVersionId,
    title: template.title,
    slug: template.slug,
    description: template.description,
    definitionText: version.definitionText,
  });
  return <TemplateDraftWorkspace
    busy={false}
    definition={definition}
    editor={readOnlyEditor}
    metaAvailable={false}
    metaTargets={[]}
    onCancel={() => undefined}
    onChange={() => undefined}
    onMetaTargetsChange={() => undefined}
    onPublish={() => undefined}
    onSave={() => undefined}
    profileOptions={profileOptions}
    publishReady={false}
    readOnly
    supportsAcpTemplateV3={false}
  />;
}

function TemplateVersionFacts({ migrationCommandAvailable, template, version }: Readonly<{
  migrationCommandAvailable: boolean;
  template?: AgentLoopTemplateStudioTemplate;
  version?: AgentLoopTemplateVersion;
}>) {
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
    {templateSchemaVersion(version.definitionText) === 2 ? <div role="status">
      <strong>schema v2 历史只读</strong>
      <p>该 Version 不能授权新 ACP Binding。{migrationCommandAvailable
        ? "选择「迁移到 ACP v3 Draft」，为每个 Profile 显式选择 Host-issued revision。"
        : "Runtime migration command not registered；迁移操作已禁用。"}</p>
    </div> : <p>创建 Task 时，Runtime 只会冻结这个 Version 的 Architecture Snapshot；后续 Draft 或导入不会改写它。</p>}
  </section>;
}

function EditorPanel({
  busy,
  editor,
  metaTargets,
  onCancel,
  onChange,
  onMetaTargetsChange,
  metaAvailable,
  onPublish,
  profileOptions,
  publishReady,
  onSave,
  supportsAcpTemplateV3,
}: Readonly<{
  busy: boolean;
  editor: AgentLoopTemplateDraftEditor;
  metaTargets: readonly AgentLoopMetaTarget[];
  onCancel: () => void;
  onChange: (patch: Partial<AgentLoopTemplateDraftEditor>) => void;
  onMetaTargetsChange: (targets: readonly AgentLoopMetaTarget[]) => void;
  metaAvailable: boolean;
  onPublish: () => void;
  profileOptions: readonly AgentLoopTemplateProfileRevisionOption[];
  publishReady: boolean;
  onSave: () => void;
  supportsAcpTemplateV3: boolean;
}>) {
  const schemaVersion = templateSchemaVersion(editor.definitionText);
  const writeReady = schemaVersion === 3 && supportsAcpTemplateV3;
  const definition = readTemplateDefinitionV3(editor.definitionText);
  if (!definition) return <section aria-label="Template Draft 编辑器" className="awb-agent-loop-template-editor">
      <header><div><p className="awb-eyebrow">{editor.templateDraftId ? `Draft r${editor.revision}` : "新 Draft"}</p><h2>{editor.templateDraftId ? "继续编辑 Draft" : "创建 Template Draft"}</h2></div><span className="awb-status">{schemaVersion ? `schema v${schemaVersion}` : "等待 ACP Profile"}</span></header>
      <div className="awb-agent-loop-template-form-grid">
        <label>模板名称<input aria-label="模板名称" data-testid="template-title" disabled={busy} onChange={(event) => onChange({ title: event.target.value })} value={editor.title} /></label>
        <label>模板 slug<input aria-label="模板 slug" disabled={busy} onChange={(event) => onChange({ slug: event.target.value })} value={editor.slug} /></label>
      </div>
      <label>说明<textarea aria-label="模板说明" disabled={busy} onChange={(event) => onChange({ description: event.target.value })} rows={3} value={editor.description} /></label>
      <ExecutionProfileEditor
        definitionText={editor.definitionText}
        disabled={busy}
        onDefinitionChange={(definitionText) => onChange({ definitionText })}
        profileOptions={profileOptions}
      />
      <label>Template 定义（Profile 字段只读）<textarea
        aria-label="Template 定义（Profile 字段只读）"
        className="awb-agent-loop-template-definition"
        data-testid="template-definition"
        readOnly
        rows={18}
        spellCheck={false}
        value={editor.definitionText || "请先选择一个 Host-issued ACP Profile revision。"}
      /></label>
      <p className="awb-agent-loop-muted">先选择 Host-ready Starter，Studio 才会建立可视化 Card 工作区。{supportsAcpTemplateV3
        ? "保存使用 revision-fenced ACP v3 Draft command。"
        : "Runtime ACP v3 Draft command 尚未注册，保存与发布已禁用。"}</p>
      <div className="awb-actions">
        <button className="awb-button awb-button-secondary" disabled={busy} onClick={onCancel} type="button">取消</button>
        <button className="awb-button awb-button-secondary" data-testid="template-save-draft" disabled={busy || !writeReady} onClick={onSave} type="button">保存草稿</button>
        <button className="awb-button awb-button-primary" data-testid="template-publish" disabled={busy || !publishReady} onClick={onPublish} type="button">发布 Version</button>
      </div>
    </section>;

  return <TemplateDraftWorkspace
    busy={busy}
    definition={definition}
    editor={editor}
    metaTargets={metaTargets}
    onCancel={onCancel}
    onChange={onChange}
    onMetaTargetsChange={onMetaTargetsChange}
    metaAvailable={metaAvailable}
    onPublish={onPublish}
    onSave={onSave}
    profileOptions={profileOptions}
    publishReady={publishReady}
    supportsAcpTemplateV3={supportsAcpTemplateV3}
  />;
}

type TemplateDraftSelection = Readonly<{ kind: "conductor" }> | Readonly<{ kind: "agent_card"; agentCardId: string }>;
type TemplateProviderFamily = AgentLoopTemplateProfileRevisionOption["providerFamily"];

function TemplateDraftWorkspace({
  busy,
  definition,
  editor,
  metaTargets,
  onCancel,
  onChange,
  onMetaTargetsChange,
  metaAvailable,
  onPublish,
  onSave,
  profileOptions,
  publishReady,
  readOnly = false,
  supportsAcpTemplateV3,
}: Readonly<{
  busy: boolean;
  definition: TemplateDefinitionV3;
  editor: AgentLoopTemplateDraftEditor;
  metaTargets: readonly AgentLoopMetaTarget[];
  onCancel: () => void;
  onChange: (patch: Partial<AgentLoopTemplateDraftEditor>) => void;
  onMetaTargetsChange: (targets: readonly AgentLoopMetaTarget[]) => void;
  metaAvailable: boolean;
  onPublish: () => void;
  onSave: () => void;
  profileOptions: readonly AgentLoopTemplateProfileRevisionOption[];
  publishReady: boolean;
  readOnly?: boolean;
  supportsAcpTemplateV3: boolean;
}>) {
  const [selection, setSelection] = useState<TemplateDraftSelection>({ kind: "conductor" });
  const [pendingProviderByProfile, setPendingProviderByProfile] = useState<Readonly<Partial<Record<string, TemplateProviderFamily>>>>({});
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  const selectedCard = selection.kind === "conductor"
    ? definition.conductor
    : definition.agentCards.find((card) => card.agentCardId === selection.agentCardId) ?? definition.conductor;
  const selectedRole = selectedCard.kind;
  const selectedProfile = definition.executionProfiles.find((profile) => profile.executionProfileId === selectedCard.executionProfileId);
  const compatibleProfileOptions = profileOptions.filter((option) => option.role === selectedRole);
  const selectedProviderFamily = selectedProfile
    ? pendingProviderByProfile[selectedProfile.executionProfileId] ?? selectedProfile.providerFamily
    : undefined;
  const providerFamilies = selectedProfile
    ? [...new Set([selectedProfile.providerFamily, ...compatibleProfileOptions.map((option) => option.providerFamily)])]
    : [];
  const modelOptions = selectedProviderFamily
    ? compatibleProfileOptions.filter((option) => (
        option.providerFamily === selectedProviderFamily && option.catalogObserved === true
      ))
    : [];
  const selectedProfileOption = selectedProfile && selectedProviderFamily === selectedProfile.providerFamily
    ? modelOptions.find((option) => option.profileRevisionId === selectedProfile.profileRevisionId)
    : undefined;
  const modelSelectionPending = Boolean(selectedProfile && selectedProviderFamily !== selectedProfile.providerFamily);
  const selectedTarget = metaTargetForCard(selectedCard);
  const selectedIsTarget = metaTargets.some((target) => metaTargetKey(target) === metaTargetKey(selectedTarget));
  const updateDefinition = (next: TemplateDefinitionV3) => onChange({ definitionText: JSON.stringify(validateTemplateDefinitionV3(next), null, 2) });
  const updateSelectedCard = (patch: Partial<AgentCardDefinition>) => {
    if (readOnly) return;
    if (selectedCard.kind === "conductor") {
      updateDefinition({ ...definition, conductor: { ...definition.conductor, ...patch } });
      return;
    }
    updateDefinition({
      ...definition,
      agentCards: definition.agentCards.map((card) => card.agentCardId === selectedCard.agentCardId
        ? { ...card, ...patch }
        : card),
    });
  };
  const setSelectedAsMetaTarget = () => onMetaTargetsChange([selectedTarget]);

  return <section aria-label={readOnly ? "Template Version Workspace" : "Template Draft Workspace"} className={`awb-template-workspace ${readOnly ? "is-read-only" : ""}`}>
    {!readOnly ? <header className="awb-template-workspace-head">
      <div>
        <p className="awb-eyebrow">Template Workspace · {editor.templateDraftId ? `Draft r${editor.revision}` : "New Draft"}</p>
        <input aria-label="模板名称" data-testid="template-title" disabled={busy} onChange={(event) => onChange({ title: event.target.value })} value={editor.title} />
        <textarea aria-label="模板说明" disabled={busy} onChange={(event) => onChange({ description: event.target.value })} rows={2} value={editor.description} />
      </div>
      <div className="awb-template-workspace-actions">
        <span className="awb-status">schema v3</span>
        {metaAvailable ? <button className="awb-button awb-button-secondary" data-testid="template-meta-target-template" disabled={busy} onClick={() => {
          onMetaTargetsChange([templateMetaTarget()]);
        }} type="button">AI 修订整个模板</button> : null}
        <button className="awb-button awb-button-secondary" data-testid="template-save-draft" disabled={busy || !supportsAcpTemplateV3} onClick={onSave} type="button">保存草稿</button>
        <button className="awb-button awb-button-primary" data-testid="template-publish" disabled={busy || !publishReady} onClick={onPublish} type="button">发布 Version</button>
        <button className="awb-button awb-button-secondary" disabled={busy} onClick={onCancel} type="button">返回模板库</button>
      </div>
      {!supportsAcpTemplateV3 ? <p className="awb-agent-loop-muted" role="status">Runtime ACP v3 Draft command 尚未注册，保存与发布已禁用。</p> : null}
    </header> : null}

    <div
      className={`awb-template-workspace-body ${inspectorOpen ? "is-inspector-open" : "is-inspector-collapsed"}`}
      style={{ "--awb-template-inspector-width": `${inspectorWidth}px` } as CSSProperties}
    >
      <main className="awb-template-object-canvas">
        <section aria-label="Conductor Charter" className={`awb-template-charter ${selectedCard.kind === "conductor" ? "is-selected" : ""}`}>
          <button data-testid="template-card-agent_card_conductor" onClick={() => setSelection({ kind: "conductor" })} type="button">
            <span className="awb-template-object-mark">C</span>
            <span><small>CONDUCTOR CHARTER · 独立于 Agent Card</small><strong>{definition.conductor.title}</strong><p>{definition.conductor.systemPrompt}</p></span>
          </button>
          {metaAvailable ? <button className="awb-button awb-button-secondary awb-button-compact" onClick={() => {
            onMetaTargetsChange([metaTargetForCard(definition.conductor)]);
          }} type="button">让 AI 修订 Charter</button> : null}
        </section>

        <section className="awb-template-platform-boundary"><strong>平台边界</strong><p>Conductor 读取 Card 的派发档案；每个 Session Agent 只读取自己的 System Prompt 与 Profile。</p></section>

        <section aria-label="Session Agent Cards" className="awb-template-agent-section">
          <header><div><h2>Session Agent Cards <span>{definition.agentCards.length} 张</span></h2><p>卡面表达可派发能力；点击后在 Inspector 编辑完整上下文。</p></div><span>选中 ≠ AI 目标</span></header>
          <div className="awb-template-agent-grid">{definition.agentCards.map((card) => {
            const profile = definition.executionProfiles.find((candidate) => candidate.executionProfileId === card.executionProfileId);
            const option = profileOptions.find((candidate) => candidate.profileRevisionId === profile?.profileRevisionId);
            const targeted = metaTargets.some((target) => metaTargetKey(target) === metaTargetKey(metaTargetForCard(card)));
            return <button
              aria-pressed={card.agentCardId === selectedCard.agentCardId}
              className={`${card.agentCardId === selectedCard.agentCardId ? "is-selected" : ""} ${targeted ? "is-ai-target" : ""}`}
              data-testid={`template-card-${card.agentCardId}`}
              key={card.agentCardId}
              onClick={() => setSelection({ kind: "agent_card", agentCardId: card.agentCardId })}
              type="button"
            >
              <span><small>{card.kind}</small>{targeted ? <em>AI 目标</em> : null}</span>
              <strong>{card.title}</strong>
              <p>{card.dispatchProfile?.description ?? card.systemPrompt}</p>
              <footer><span>{profile ? `${profile.providerFamily} · ${profile.model}` : "Profile missing"}</span><span>{option?.readiness.status ?? "unavailable"}</span></footer>
            </button>;
          })}</div>
          {metaAvailable ? <button className="awb-template-add-agent" onClick={() => {
            onMetaTargetsChange([templateMetaTarget()]);
          }} type="button"><strong>通过 AI 调整 Agent Card 结构</strong><small>Meta 只会提出 Proposal，应用前不会改变 Draft。</small></button> : null}
        </section>

        <details className="awb-template-advanced">
          <summary>Runtime details 与完整 Template 定义</summary>
          <ExecutionProfileEditor
            definitionText={editor.definitionText}
            disabled={busy || readOnly}
            onDefinitionChange={(definitionText) => onChange({ definitionText })}
            profileOptions={profileOptions}
          />
          <label>Template 定义（Profile 字段只读）<textarea
            aria-label="Template 定义（Profile 字段只读）"
            className="awb-agent-loop-template-definition"
            data-testid="template-definition"
            readOnly
            rows={18}
            spellCheck={false}
            value={editor.definitionText}
          /></label>
        </details>
      </main>

      {inspectorOpen ? <HorizontalPaneResizer
        ariaLabel="调整 Agent Inspector 宽度"
        max={520}
        min={260}
        onChange={setInspectorWidth}
        side="right"
        value={inspectorWidth}
      /> : null}

      {inspectorOpen ? <aside aria-label="Agent Card Inspector" className="awb-template-inspector">
        <header><div><p className="awb-eyebrow">{selectedCard.kind === "conductor" ? "Conductor Charter" : "Agent Card Inspector"}</p><h2>{selectedCard.title}</h2></div><div className="awb-template-inspector-actions"><span>{selectedCard.kind}</span><button aria-label="收起 Agent Inspector" className="awb-agent-loop-icon-button" data-testid="template-inspector-collapse" onClick={() => setInspectorOpen(false)} title="收起 Agent Inspector" type="button"><PanelRightClose aria-hidden="true" size={16} /></button></div></header>
        <label>名称<input aria-label={`${selectedCard.title} 名称`} disabled={busy || readOnly} onChange={(event) => updateSelectedCard({ title: event.target.value })} value={selectedCard.title} /></label>
        {selectedCard.kind !== "conductor" && selectedCard.dispatchProfile ? <>
          <label>Conductor 派发标题<input aria-label={`${selectedCard.title} 派发标题`} disabled={busy || readOnly} onChange={(event) => updateSelectedCard({ dispatchProfile: { ...selectedCard.dispatchProfile!, title: event.target.value } })} value={selectedCard.dispatchProfile.title} /></label>
          <label>Conductor 派发说明<textarea aria-label={`${selectedCard.title} 派发说明`} disabled={busy || readOnly} onChange={(event) => updateSelectedCard({ dispatchProfile: { ...selectedCard.dispatchProfile!, description: event.target.value } })} rows={4} value={selectedCard.dispatchProfile.description} /></label>
        </> : null}
        <label>{selectedCard.title} System Prompt<textarea aria-label={`${selectedCard.title} System Prompt`} disabled={busy || readOnly} onChange={(event) => updateSelectedCard({ systemPrompt: event.target.value })} rows={9} value={selectedCard.systemPrompt} /></label>
        {selectedProfile && selectedProviderFamily ? <fieldset className="awb-template-profile-picker">
          <legend>执行环境</legend>
          <label>Provider<select
            aria-label={`${selectedCard.title} Provider`}
            disabled={busy || readOnly}
            onChange={(event) => {
              setPendingProviderByProfile((current) => Object.freeze({
                ...current,
                [selectedProfile.executionProfileId]: event.target.value as TemplateProviderFamily,
              }));
            }}
            value={selectedProviderFamily}
          >{providerFamilies.map((providerFamily) => <option key={providerFamily} value={providerFamily}>{providerFamilyLabel(providerFamily)}</option>)}</select></label>
          <label>Model<select
            aria-label={`${selectedCard.title} Model`}
            disabled={busy || readOnly}
            onChange={(event) => {
              const option = modelOptions.find((candidate) => candidate.profileRevisionId === event.target.value);
              if (!option?.catalogObserved) return;
              onChange({ definitionText: replaceProfileRevision(definition, selectedProfile.executionProfileId, option) });
              setPendingProviderByProfile((current) => withoutPendingProvider(current, selectedProfile.executionProfileId));
            }}
            value={modelSelectionPending ? "" : selectedProfile.profileRevisionId}
          >
            {modelSelectionPending ? <option value="">选择 {providerFamilyLabel(selectedProviderFamily)} 模型</option> : null}
            {!modelSelectionPending && !selectedProfileOption ? <option value={selectedProfile.profileRevisionId}>{selectedProfile.model} · 当前组合未由 Host 提供</option> : null}
            {modelOptions.length
              ? modelOptions.map(modelOptionElement)
              : <option disabled value="">ACP 尚未返回模型目录</option>}
          </select></label>
          <small>{modelSelectionPending
            ? "选择模型后才会将新的 Provider / Model 组合写入 Draft。"
            : "每个 Agent 独立使用一个 Host 已提供并验证的 Provider / Model 组合。"}</small>
        </fieldset> : null}
        {metaAvailable ? <button className={`awb-button ${selectedIsTarget ? "awb-button-secondary" : "awb-button-primary"}`} onClick={() => {
          setSelectedAsMetaTarget();
        }} type="button">{selectedIsTarget ? `${selectedCard.title} 已是 AI 目标` : `将 ${selectedCard.title} 加入 AI 目标`}</button> : null}
      </aside> : <aside aria-label="Agent Inspector launcher" className="awb-template-inspector-launcher"><button aria-label="打开 Agent Inspector" data-testid="template-inspector-open" onClick={() => setInspectorOpen(true)} title="打开 Agent Inspector" type="button"><PanelRightOpen aria-hidden="true" size={17} /><span>Inspector</span></button></aside>}
    </div>
  </section>;
}

function HorizontalPaneResizer({
  ariaLabel,
  max,
  min,
  onChange,
  side,
  value,
}: Readonly<{
  ariaLabel: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  side: "left" | "right";
  value: number;
}>) {
  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startValue = value;
    const direction = side === "left" ? 1 : -1;
    document.body.classList.add("awb-agent-loop-resizing");
    const move = (moveEvent: PointerEvent) => {
      onChange(clamp(startValue + ((moveEvent.clientX - startX) * direction), min, max));
    };
    const stop = () => {
      document.body.classList.remove("awb-agent-loop-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  };
  return <button
    aria-label={ariaLabel}
    aria-orientation="vertical"
    className={`awb-agent-loop-pane-resizer is-template-${side}`}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = side === "left" ? 1 : -1;
      const keyboardDelta = event.key === "ArrowRight" ? 16 : -16;
      onChange(clamp(value + (keyboardDelta * direction), min, max));
    }}
    onPointerDown={beginResize}
    role="separator"
    type="button"
  />;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function ExecutionProfileEditor({
  definitionText,
  disabled,
  onDefinitionChange,
  profileOptions,
}: Readonly<{
  definitionText: string;
  disabled: boolean;
  onDefinitionChange: (definitionText: string) => void;
  profileOptions: readonly AgentLoopTemplateProfileRevisionOption[];
}>) {
  const definition = readTemplateDefinitionV3(definitionText);
  if (!definition) {
    if (templateSchemaVersion(definitionText) === 2) {
      return <section aria-label="执行配置" className="awb-agent-loop-profile-editor is-legacy">
        <strong>schema v2 历史只读</strong>
        <p>不能在原 Draft 中修改 Provider/model 或 Host-private resolution 字段。请从已发布 Version 发起显式 ACP v3 迁移。</p>
      </section>;
    }
    const starters = profileOptions.filter((option) => isStarterConductor(option, profileOptions));
    const selected = starters.find((option) => option.readiness.status === "available"
      && readyStarterWorker(option, profileOptions) !== undefined);
    return <section aria-label="执行配置" className="awb-agent-loop-profile-editor is-unconfigured">
      <header><div><p className="awb-eyebrow">HOST-ISSUED ACP PROFILE</p><h3>执行配置</h3></div><span>0 Profile</span></header>
      <label>新 Draft Starter<select
        aria-label="新 Draft Starter"
        data-testid="template-starter-profile"
        disabled={disabled || starters.length === 0}
        onChange={(event) => {
          const option = starters.find((candidate) => candidate.profileRevisionId === event.target.value);
          if (option?.readiness.status === "available" && readyStarterWorker(option, profileOptions)) {
            onDefinitionChange(JSON.stringify(defaultV3Definition(option, profileOptions), null, 2));
          }
        }}
        value=""
      >
        <option value="">选择 Host-ready Starter</option>
        {starters.map(profileOptionElement)}
      </select></label>
      {starters.length === 0 ? <p>Host 尚未投影同时包含 Conductor 与 Worker 的可用 ACP Starter；Renderer 不会拼装或伪造 Profile。</p> : null}
      {selected ? <AgentLoopAcpProfileSummary
        readiness={selected.readiness}
        requiredCapabilities={selected.capabilityPolicy.requiredCapabilities}
        requiredExtensions={selected.requiredExtensions}
        title="Available ACP Profile"
      /> : null}
    </section>;
  }
  return <section aria-label="执行配置" className="awb-agent-loop-profile-editor">
    <header><div><p className="awb-eyebrow">HOST-ISSUED ACP PROFILE</p><h3>执行配置</h3></div><span>{definition.executionProfiles.length} 个 Profile</span></header>
    <p>只选择 Host-issued Profile revision。Provider/model 是该 revision 的只读 portable requirement，安装版本与路径不进入 Template。</p>
    <div className="awb-agent-loop-profile-grid">
      {definition.executionProfiles.map((profile) => {
        const selected = profileOptions.find((option) => option.profileRevisionId === profile.profileRevisionId);
        const role = definitionProfileRole(definition, profile.executionProfileId);
        const compatibleOptions = role ? profileOptions.filter((option) => option.role === role) : [];
        return <article key={profile.executionProfileId}>
          <header><strong>{profile.executionProfileId}</strong><span>{selected?.title ?? "Host option unavailable"}</span></header>
          <label>Profile revision<select
            aria-label={`${profile.executionProfileId} Profile revision`}
            disabled={disabled}
            onChange={(event) => {
              const option = profileOptions.find((candidate) => candidate.profileRevisionId === event.target.value);
              if (option?.readiness.status === "available") {
                onDefinitionChange(replaceProfileRevision(definition, profile.executionProfileId, option));
              }
            }}
            value={selected?.profileRevisionId ?? ""}
          >
            {!selected ? <option value="">Exact revision is not currently projected</option> : null}
            {compatibleOptions.map(profileOptionElement)}
          </select></label>
          {selected ? <AgentLoopAcpProfileSummary
            allowedTools={selected.capabilityPolicy.allowedTools}
            permissionMode={selected.capabilityPolicy.permissionMode}
            readiness={selected.readiness}
            requiredCapabilities={selected.capabilityPolicy.requiredCapabilities}
            requiredExtensions={selected.requiredExtensions}
            title={`Profile ${profile.executionProfileId}`}
          /> : <p role="status">精确 Profile revision 当前不在 Host options 中；不会按 Provider 品牌或 model 猜测替代项。</p>}
        </article>;
      })}
    </div>
  </section>;
}

function LegacyVersionMigration({
  busy,
  canMigrate,
  onCancel,
  onMigrate,
  profileOptions,
  source,
}: Readonly<{
  busy: boolean;
  canMigrate: boolean;
  onCancel: () => void;
  onMigrate: (selections: readonly Readonly<{ executionProfileId: string; profileRevisionId: string }>[]) => void;
  profileOptions: readonly AgentLoopTemplateProfileRevisionOption[];
  source: AgentLoopTemplateVersion;
}>) {
  const [selections, setSelections] = useState<Readonly<Record<string, string>>>({});
  const profileIds = legacyExecutionProfileIds(source.definitionText);
  if (!profileIds) return <section aria-label="ACP v3 迁移" className="awb-agent-loop-template-contract is-invalid">
    <strong>schema v2 Version 无法解析</strong>
    <p>Runtime 不会猜测或原地改写已发布字节。</p>
    <button className="awb-button awb-button-secondary" onClick={onCancel} type="button">返回</button>
  </section>;
  const complete = profileIds.length > 0 && profileIds.every((executionProfileId) => {
    const revisionId = selections[executionProfileId];
    return profileOptions.some((option) => option.profileRevisionId === revisionId && option.readiness.status === "available");
  });
  return <section aria-label="ACP v3 迁移" className="awb-agent-loop-template-contract">
    <header><div><p className="awb-eyebrow">EXPLICIT MIGRATION INTENT</p><h2>schema v2 → ACP v3 Draft</h2></div><span>{source.templateVersionId}</span></header>
    <p>源 Version 保持不可变。为每个 legacy executionProfileId 选择一个 Host-issued portable revision；不可用项可见但不能提交。</p>
    {profileIds.map((executionProfileId) => <label key={executionProfileId}>{executionProfileId}<select
      aria-label={`${executionProfileId} migration Profile revision`}
      disabled={busy || !canMigrate}
      onChange={(event) => setSelections((current) => Object.freeze({ ...current, [executionProfileId]: event.target.value }))}
      value={selections[executionProfileId] ?? ""}
    >
      <option value="">选择 Host-ready revision</option>
      {profileOptions.map(profileOptionElement)}
    </select></label>)}
    {!canMigrate ? <p role="status">Runtime migration command not registered；当前只能审阅历史 v2 Version。</p> : null}
    <div className="awb-actions">
      <button className="awb-button awb-button-secondary" disabled={busy} onClick={onCancel} type="button">取消</button>
      <button
        className="awb-button awb-button-primary"
        data-testid="template-migrate-v3"
        disabled={busy || !canMigrate || !complete}
        onClick={() => onMigrate(profileIds.map((executionProfileId) => ({
          executionProfileId,
          profileRevisionId: requiredProfileSelection(selections[executionProfileId]),
        })))}
        type="button"
      >创建新 ACP v3 Draft</button>
    </div>
  </section>;
}

function profileOptionElement(option: AgentLoopTemplateProfileRevisionOption) {
  return <option
    disabled={option.readiness.status !== "available"}
    key={option.profileRevisionId}
    value={option.profileRevisionId}
  >{option.title} · {option.profileRevisionId} · {option.readiness.status}</option>;
}

function modelOptionElement(option: AgentLoopTemplateProfileRevisionOption) {
  const readiness = option.readiness.status === "available"
    ? " · 已验证"
    : " · ACP 可选，待验证";
  return <option
    key={option.profileRevisionId}
    title={`${providerFamilyLabel(option.providerFamily)} · ${option.model}${readiness}`}
    value={option.profileRevisionId}
  >{option.model}{readiness}</option>;
}

function withoutPendingProvider(
  current: Readonly<Partial<Record<string, TemplateProviderFamily>>>,
  executionProfileId: string,
): Readonly<Partial<Record<string, TemplateProviderFamily>>> {
  const next = { ...current };
  delete next[executionProfileId];
  return Object.freeze(next);
}

function providerFamilyLabel(providerFamily: AgentLoopTemplateProfileRevisionOption["providerFamily"]): string {
  switch (providerFamily) {
    case "codex": return "Codex";
    case "opencode": return "OpenCode";
    case "claude-code": return "Claude Code";
  }
}

function profileReadinessLabel(
  status: AgentLoopTemplateProfileRevisionOption["readiness"]["status"],
  reasons: readonly string[] = [],
): string {
  switch (status) {
    case "available": return "可用";
    case "checking": return "检查中";
    case "capability_missing": return "能力不足";
    case "unavailable": return reasons.includes("acp_task_provider_not_configured")
      ? "未配置"
      : reasons.includes("profile_not_qualified")
        ? "未验证"
        : "不可用";
  }
}

function requiredProfileSelection(value: string | undefined): string {
  if (!value) throw new Error("acp_profile_revision_selection_required");
  return value;
}

function readTemplateDefinitionV3(source: string): TemplateDefinitionV3 | undefined {
  if (!source.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    return validateTemplateDefinitionV3(value);
  } catch {
    return undefined;
  }
}

function legacyExecutionProfileIds(source: string): readonly string[] | undefined {
  try {
    const value: unknown = JSON.parse(source);
    return validateTemplateDefinition(value).executionProfiles.map((profile) => profile.executionProfileId);
  } catch {
    return undefined;
  }
}

function templateSchemaVersion(source: string): 2 | 3 | undefined {
  if (!source.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const schemaVersion = Reflect.get(value, "schemaVersion");
    return schemaVersion === 2 || schemaVersion === 3 ? schemaVersion : undefined;
  } catch {
    return undefined;
  }
}

function templateMetaTarget(): AgentLoopMetaTarget {
  return Object.freeze({ kind: "template", label: "Template" });
}

function metaTargetForCard(card: AgentCardDefinition): AgentLoopMetaTarget {
  return card.kind === "conductor"
    ? Object.freeze({ kind: "conductor", agentCardId: card.agentCardId, label: card.title })
    : Object.freeze({ kind: "agent_card", agentCardId: card.agentCardId, label: card.title });
}

function metaTargetKey(target: AgentLoopMetaTarget): string {
  return target.kind === "template" ? "template" : `${target.kind}:${target.agentCardId}`;
}

function metaTargetToken(target: AgentLoopMetaTarget): string {
  if (target.kind === "template") return "@Template";
  if (target.kind === "conductor") return "@Conductor";
  return `@${target.label}`;
}

function replaceProfileRevision(
  definition: TemplateDefinitionV3,
  executionProfileId: string,
  option: AgentLoopTemplateProfileRevisionOption,
): string {
  return JSON.stringify(validateTemplateDefinitionV3({
    ...definition,
    executionProfiles: definition.executionProfiles.map((profile) => profile.executionProfileId === executionProfileId
      ? executionProfileFromOption(executionProfileId, option)
      : profile),
  }), null, 2);
}

function executionProfileFromOption(
  executionProfileId: string,
  option: AgentLoopTemplateProfileRevisionOption,
): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId,
    profileRevisionId: option.profileRevisionId,
    providerFamily: option.providerFamily,
    acpAgentKind: option.acpAgentKind,
    protocolMajor: option.protocolMajor,
    model: option.model,
    configIntent: option.configIntent,
    requiredExtensions: [...option.requiredExtensions],
    capabilityPolicy: {
      ...option.capabilityPolicy,
      requiredCapabilities: [...option.capabilityPolicy.requiredCapabilities],
      allowedTools: [...option.capabilityPolicy.allowedTools],
    },
  };
}

function defaultV3Definition(
  conductorOption: AgentLoopTemplateProfileRevisionOption,
  options: readonly AgentLoopTemplateProfileRevisionOption[],
): TemplateDefinitionV3 {
  const workerOption = readyStarterWorker(conductorOption, options);
  if (conductorOption.role !== "conductor" || conductorOption.readiness.status !== "available" || !workerOption) {
    throw new Error("agent_loop_acp_starter_profile_pair_unavailable");
  }
  return validateTemplateDefinitionV3({
    schemaVersion: 3,
    conductor: {
      agentCardId: "agent_card_conductor",
      kind: "conductor",
      title: "Conductor",
      executionProfileId: conductorOption.executionProfileId,
      systemPrompt: "Coordinate the Task from durable Runtime evidence and dispatch bounded work.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: "agent_card_worker",
      kind: "general",
      title: "Worker",
      executionProfileId: workerOption.executionProfileId,
      systemPrompt: "Complete only the scoped objective and return verifiable results.",
      capabilityRefs: [],
      dispatchProfile: {
        title: "Scoped work",
        description: "Use for one bounded assignment with explicit completion criteria.",
      },
    }],
    executionProfiles: [
      executionProfileFromOption(conductorOption.executionProfileId, conductorOption),
      executionProfileFromOption(workerOption.executionProfileId, workerOption),
    ],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{
      artifactPath: "artifacts/result.md",
      ownerAgentCardId: "agent_card_worker",
      description: "The worker's verifiable result.",
    }],
  });
}

function isStarterConductor(
  option: AgentLoopTemplateProfileRevisionOption,
  options: readonly AgentLoopTemplateProfileRevisionOption[],
): boolean {
  return option.role === "conductor"
    && options.some((candidate) => candidate.sourceTemplateVersionId === option.sourceTemplateVersionId
      && candidate.role === "general");
}

function readyStarterWorker(
  conductorOption: AgentLoopTemplateProfileRevisionOption,
  options: readonly AgentLoopTemplateProfileRevisionOption[],
): AgentLoopTemplateProfileRevisionOption | undefined {
  return options.find((option) => option.sourceTemplateVersionId === conductorOption.sourceTemplateVersionId
    && option.role === "general"
    && option.readiness.status === "available");
}

function definitionProfileRole(
  definition: TemplateDefinitionV3,
  executionProfileId: string,
): AgentLoopTemplateProfileRevisionOption["role"] | undefined {
  const roles = new Set<AgentLoopTemplateProfileRevisionOption["role"]>();
  if (definition.conductor.executionProfileId === executionProfileId) roles.add("conductor");
  for (const card of definition.agentCards) {
    if (card.executionProfileId === executionProfileId) roles.add(card.kind);
  }
  if (roles.size !== 1) return undefined;
  return [...roles][0]!;
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

function DraftIndexRow({ draft, onOpen }: Readonly<{ draft: AgentLoopTemplateStudioDraft; onOpen: () => void }>) {
  return <button className="awb-template-index-row is-draft" onClick={onOpen} type="button">
    <span className="awb-template-index-mark">D</span>
    <span><strong>{draft.title}</strong><small>{draft.description || "继续当前 Template Draft"}</small></span>
    <span><b>r{draft.revision}</b><small>Draft</small></span>
    <span aria-hidden="true">→</span>
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
