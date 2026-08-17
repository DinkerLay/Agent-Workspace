import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AcpProviderInstallationInput,
  AcpProviderSettingsEntry,
  AcpProviderSettingsReadModel,
  ProviderFamily,
} from "@agent-workspace/runtime-contracts";

export type AgentLoopProviderSettingsController = Readonly<{
  load(): Promise<AcpProviderSettingsReadModel>;
  discoverInstallation(providerFamily: ProviderFamily): Promise<AcpProviderSettingsReadModel>;
  configureInstallation(
    providerFamily: ProviderFamily,
    installation: AcpProviderInstallationInput,
  ): Promise<AcpProviderSettingsReadModel>;
  refreshModels(providerFamily: ProviderFamily): Promise<AcpProviderSettingsReadModel>;
  configureChatModels(
    providerFamily: ProviderFamily,
    modelIds: readonly string[],
    defaultModelId: string,
  ): Promise<AcpProviderSettingsReadModel>;
}>;

type ProviderOperation = "discover" | "configure" | "models" | "chat-models";
type ProviderPathForm = Readonly<{
  providerCli: string;
  node: string;
  credentialSource: string;
}>;

const PROVIDERS = Object.freeze(["opencode", "codex", "claude-code"] as const);
const EMPTY_PATHS: ProviderPathForm = Object.freeze({
  providerCli: "",
  node: "",
  credentialSource: "",
});

export function AgentLoopProviderSettings({
  controller,
}: Readonly<{ controller: AgentLoopProviderSettingsController }>) {
  const [model, setModel] = useState<AcpProviderSettingsReadModel>();
  const [selectedFamily, setSelectedFamily] = useState<ProviderFamily>("codex");
  const [operation, setOperation] = useState<ProviderOperation>();
  const [paths, setPaths] = useState<ProviderPathForm>(EMPTY_PATHS);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [enabledModelIds, setEnabledModelIds] = useState<readonly string[]>([]);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const next = await controller.load();
    if (mounted.current) setModel(next);
  }, [controller]);

  useEffect(() => {
    mounted.current = true;
    void load().catch((reason: unknown) => {
      if (mounted.current) setError(messageFor(reason));
    });
    return () => { mounted.current = false; };
  }, [load]);

  const selectedProvider = model?.providers.find((provider) => provider.providerFamily === selectedFamily);

  useEffect(() => {
    if (!selectedProvider) return;
    setPaths(pathsFromProvider(selectedProvider));
    const enabled = selectedProvider.enabledChatModelIds ?? [];
    setEnabledModelIds(enabled);
    setSelectedModelId(selectedProvider.defaultModelId && enabled.includes(selectedProvider.defaultModelId)
      ? selectedProvider.defaultModelId
      : enabled[0] ?? "");
  }, [selectedProvider]);

  const run = async (
    nextOperation: ProviderOperation,
    effect: () => Promise<AcpProviderSettingsReadModel>,
  ) => {
    setOperation(nextOperation);
    setError(undefined);
    try {
      const next = await effect();
      if (mounted.current) setModel(next);
    } catch (reason) {
      if (mounted.current) setError(messageFor(reason));
    } finally {
      if (mounted.current) setOperation(undefined);
    }
  };

  const discover = async () => {
    await run("discover", () => controller.discoverInstallation(selectedFamily));
  };

  const configure = async () => {
    if (!selectedProvider) return;
    await run("configure", () => controller.configureInstallation(
      selectedFamily,
      installationInput(selectedFamily, paths),
    ));
  };

  const refreshModels = async () => {
    await run("models", () => controller.refreshModels(selectedFamily));
  };

  const saveChatModels = async () => {
    if (!selectedModelId || enabledModelIds.length === 0) return;
    await run("chat-models", () => controller.configureChatModels(
      selectedFamily,
      enabledModelIds,
      selectedModelId,
    ));
  };

  const toggleModel = (modelId: string, enabled: boolean) => {
    setEnabledModelIds((current) => {
      const next = enabled
        ? [...current, modelId]
        : current.filter((candidate) => candidate !== modelId);
      if (!enabled && selectedModelId === modelId) setSelectedModelId(next[0] ?? "");
      if (enabled && !selectedModelId) setSelectedModelId(modelId);
      return Object.freeze(next);
    });
  };

  return <section className="awb-provider-settings" aria-labelledby="acp-provider-settings-heading">
    <header className="awb-provider-settings-header">
      <div>
        <p>RUNTIME SETTINGS</p>
        <h1 id="acp-provider-settings-heading">ACP Provider 设置</h1>
        <span>为这台设备确认 CLI 与登录源，再选择哪些真实 ACP 模型出现在 Chat。</span>
      </div>
    </header>

    <div className="awb-provider-settings-callout">
      <strong>设备连接和 Chat 模型分开管理</strong>
      <p>扫描只检查本机文件；刷新目录只读取 ACP 声明的模型。你勾选的模型会出现在新 Chat，已有 Session 保持原选择。</p>
    </div>

    {error ? <p className="awb-notice is-error" role="alert">{humanError(error)}</p> : null}
    {!model || !selectedProvider
      ? <p className="awb-provider-settings-loading">正在读取 Host 设置…</p>
      : <div className="awb-provider-settings-layout">
        <nav className="awb-provider-settings-nav" aria-label="ACP Provider">
          {PROVIDERS.map((providerFamily) => {
            const provider = model.providers.find((entry) => entry.providerFamily === providerFamily);
            if (!provider) return null;
            return <button
              aria-pressed={selectedFamily === providerFamily}
              className={selectedFamily === providerFamily ? "is-selected" : undefined}
              key={providerFamily}
              onClick={() => setSelectedFamily(providerFamily)}
              type="button"
            >
              <span>{provider.displayName}</span>
              <small>{setupLabel(provider)}</small>
            </button>;
          })}
        </nav>
        <ProviderSetupDetail
          busy={operation}
          onConfigure={() => void configure()}
          onDiscover={() => void discover()}
          onPathChange={(key, value) => setPaths((current) => Object.freeze({ ...current, [key]: value }))}
          onRefreshModels={() => void refreshModels()}
          onSaveChatModels={() => void saveChatModels()}
          onSelectedModelChange={setSelectedModelId}
          onToggleModel={toggleModel}
          paths={paths}
          provider={selectedProvider}
          enabledModelIds={enabledModelIds}
          selectedModelId={selectedModelId}
        />
      </div>}

    <p className="awb-provider-settings-privacy">路径和登录文件只由本机 Runtime Host 保存；Template、Task、聊天记录和 ACP wire 都不会持久化这些值。</p>
  </section>;
}

function ProviderSetupDetail({
  busy,
  enabledModelIds,
  onConfigure,
  onDiscover,
  onPathChange,
  onRefreshModels,
  onSaveChatModels,
  onSelectedModelChange,
  onToggleModel,
  paths,
  provider,
  selectedModelId,
}: Readonly<{
  busy?: ProviderOperation;
  enabledModelIds: readonly string[];
  onConfigure(): void;
  onDiscover(): void;
  onPathChange(key: keyof ProviderPathForm, value: string): void;
  onRefreshModels(): void;
  onSaveChatModels(): void;
  onSelectedModelChange(value: string): void;
  onToggleModel(modelId: string, enabled: boolean): void;
  paths: ProviderPathForm;
  provider: AcpProviderSettingsEntry;
  selectedModelId: string;
}>) {
  const environmentManaged = provider.configurationSource === "environment";
  const canConfigure = !environmentManaged && requiredPathValues(provider.providerFamily, paths).every(Boolean);
  const canProbeModels = provider.configured;
  const canSaveChatModels = enabledModelIds.length > 0
    && enabledModelIds.includes(selectedModelId)
    && enabledModelIds.every((modelId) => provider.models.some((model) => model.modelId === modelId))
    && !environmentManaged;
  return <article className="awb-provider-settings-detail">
    <header>
      <div><p>ACP PROVIDER</p><h2>{provider.displayName}</h2></div>
      <span className={`awb-provider-status is-${provider.status}`}>{statusLabel(provider)}</span>
    </header>

    <section className="awb-provider-settings-step" aria-labelledby={`${provider.providerFamily}-installation-heading`}>
      <div className="awb-provider-settings-step-heading">
        <div>
          <h3 id={`${provider.providerFamily}-installation-heading`}>设备连接</h3>
          <p>Agent Workspace 管理 ACP runtime；这里只确认这台设备上的 Provider CLI 与登录源。</p>
        </div>
        <button className="awb-button awb-button-secondary" disabled={busy !== undefined} onClick={onDiscover} type="button">
          {busy === "discover" ? "正在扫描…" : "扫描本机安装"}
        </button>
      </div>
      {provider.installation.status === "not_scanned"
        ? <div className="awb-provider-empty-action">尚未扫描。扫描不会启动 Provider 或读取登录内容。</div>
        : <ul className="awb-provider-component-list">
          {provider.installation.components.map((component) => <li key={component.kind}>
            <span className={component.status === "found" ? "is-found" : "is-missing"} aria-hidden="true" />
            <div><strong>{component.label}</strong><small>{component.displayPath ?? "未找到，请在下方选择"}</small></div>
            <em>{component.status === "found" ? "已找到" : "缺失"}</em>
          </li>)}
        </ul>}
      {environmentManaged
        ? <p className="awb-provider-managed-note">当前由 Runtime Host 启动环境管理。页面只读，不覆盖部署配置。</p>
        : <ProviderPathFields providerFamily={provider.providerFamily} paths={paths} onChange={onPathChange} />}
      {!environmentManaged ? <div className="awb-provider-settings-actions">
        <button className="awb-button awb-button-primary" disabled={!canConfigure || busy !== undefined} onClick={onConfigure} type="button">
          {busy === "configure" ? "正在保存…" : "保存设备配置"}
        </button>
        {!canConfigure ? <span>补齐所有必需路径后即可保存。</span> : null}
      </div> : null}
      {provider.configurationSource === "local" ? <p className="awb-provider-apply-note" role="status">
        已应用到后续新 Session；当前正在运行的 Session 保持原配置。
      </p> : null}
    </section>

    <section className="awb-provider-settings-step" aria-labelledby={`${provider.providerFamily}-models-heading`}>
      <div className="awb-provider-settings-step-heading">
        <div>
          <h3 id={`${provider.providerFamily}-models-heading`}>Chat 模型</h3>
          <p>这里是 ACP Agent 声明的模型目录；勾选后才会出现在新 Chat。</p>
        </div>
        {canProbeModels ? <button className="awb-button awb-button-secondary" disabled={busy !== undefined} onClick={onRefreshModels} type="button">
          {busy === "models" ? "正在连接…" : "刷新模型目录"}
        </button> : null}
      </div>
      {!provider.configured
        ? <div className="awb-provider-empty-action">先保存设备连接，之后即可读取模型。</div>
        : provider.models.length === 0
          ? <div className="awb-provider-empty-action">尚未读取模型。点击“刷新模型目录”发起一次显式探测。</div>
          : <>
            <section className="awb-provider-model-catalog" aria-labelledby={`${provider.providerFamily}-catalog-heading`}>
              <h4 id={`${provider.providerFamily}-catalog-heading`}>已发现模型 ({provider.models.length})</h4>
              <ul>
                {provider.models.map((model) => <li data-testid={`provider-model-${model.modelId}`} key={model.modelId}>
                  <label className="awb-provider-model-choice">
                    <input
                      checked={enabledModelIds.includes(model.modelId)}
                      disabled={environmentManaged || busy !== undefined}
                      onChange={(event) => onToggleModel(model.modelId, event.currentTarget.checked)}
                      type="checkbox"
                    />
                    <span><strong>{model.label}</strong><code>{model.modelId}</code></span>
                  </label>
                  <label className="awb-provider-model-default">
                    <input
                      checked={selectedModelId === model.modelId}
                      disabled={environmentManaged || busy !== undefined || !enabledModelIds.includes(model.modelId)}
                      name={`${provider.providerFamily}-default-model`}
                      onChange={() => onSelectedModelChange(model.modelId)}
                      type="radio"
                    /> 默认
                  </label>
                </li>)}
              </ul>
            </section>
            <div className="awb-provider-settings-actions">
              <button className="awb-button awb-button-primary" disabled={!canSaveChatModels || busy !== undefined} onClick={onSaveChatModels} type="button">
                {busy === "chat-models" ? "正在保存…" : `保存到 Chat (${enabledModelIds.length})`}
              </button>
              <span>新 Chat 首次发送前仍可选择 Provider、Model 与 Effort。</span>
            </div>
            <p className="awb-provider-model-catalog-note">目录发现或勾选不等于运行可用。每个新 Session 仍会按 Provider、Model、角色与 Effort 执行 ACP readiness 验证。</p>
          </>}
      {provider.defaultModelId ? <p className="awb-provider-current-default">新 Chat 默认：<code>{provider.defaultModelId}</code></p> : null}
    </section>
  </article>;
}

function ProviderPathFields({
  onChange,
  paths,
  providerFamily,
}: Readonly<{
  onChange(key: keyof ProviderPathForm, value: string): void;
  paths: ProviderPathForm;
  providerFamily: ProviderFamily;
}>) {
  return <fieldset className="awb-provider-path-fields">
    <legend>安装路径</legend>
    <PathField label={`${providerTitle(providerFamily)} CLI`} value={paths.providerCli} onChange={(value) => onChange("providerCli", value)} />
    {providerFamily !== "opencode" ? <PathField label="Node.js" value={paths.node} onChange={(value) => onChange("node", value)} /> : null}
    <PathField label={providerFamily === "claude-code" ? "Claude/CCSwitch 设置" : "登录文件"} value={paths.credentialSource} onChange={(value) => onChange("credentialSource", value)} />
  </fieldset>;
}

function PathField({ label, onChange, value }: Readonly<{
  label: string;
  onChange(value: string): void;
  value: string;
}>) {
  return <label>{label}
    <input onChange={(event) => onChange(event.currentTarget.value)} placeholder="粘贴或输入本机路径" spellCheck={false} type="text" value={value} />
  </label>;
}

function pathsFromProvider(provider: AcpProviderSettingsEntry): ProviderPathForm {
  const byKind = new Map(provider.installation.components.map((component) => [component.kind, component.displayPath ?? ""]));
  return Object.freeze({
    providerCli: byKind.get("provider_cli") ?? "",
    node: byKind.get("node") ?? "",
    credentialSource: byKind.get("credential_source") ?? "",
  });
}

function requiredPathValues(providerFamily: ProviderFamily, paths: ProviderPathForm): readonly string[] {
  return providerFamily === "opencode"
    ? [paths.providerCli, paths.credentialSource]
    : [paths.providerCli, paths.node, paths.credentialSource];
}

function installationInput(providerFamily: ProviderFamily, paths: ProviderPathForm): AcpProviderInstallationInput {
  if (providerFamily === "opencode") {
    return Object.freeze({ kind: "opencode", commandPath: paths.providerCli, authFilePath: paths.credentialSource });
  }
  if (providerFamily === "codex") {
    return Object.freeze({
      kind: "codex",
      codexPath: paths.providerCli,
      nodePath: paths.node,
      authFilePath: paths.credentialSource,
    });
  }
  return Object.freeze({
    kind: "claude-code",
    claudePath: paths.providerCli,
    nodePath: paths.node,
    settingsFilePath: paths.credentialSource,
  });
}

function setupLabel(provider: AcpProviderSettingsEntry): string {
  if (provider.models.length > 0) return `已发现 ${provider.models.length} 个模型`;
  if (provider.configured) return statusLabel(provider);
  if (provider.installation.status === "ready") return "安装已确认";
  if (provider.installation.status === "incomplete") return "安装不完整";
  return "需要设置";
}

function statusLabel(provider: AcpProviderSettingsEntry): string {
  if (provider.models.length > 0 && provider.status === "not_checked") return "模型目录已发现";
  if (provider.status === "not_configured") return "未配置";
  if (provider.status === "not_checked") return "未检测";
  if (provider.status === "checking") return "检测中";
  if (provider.status === "available") return "可用";
  if (provider.status === "capability_missing") return "能力不完整";
  return "不可用";
}

function providerTitle(providerFamily: ProviderFamily): string {
  if (providerFamily === "opencode") return "OpenCode";
  if (providerFamily === "codex") return "Codex";
  return "Claude Code";
}

function humanError(value: string): string {
  const messages: Record<string, string> = {
    session_id_acp_provider_environment_managed: "当前由 Runtime Host 启动环境管理，不能在页面覆盖。",
    session_id_acp_provider_model_not_observed: "该模型不在本次 ACP Agent 返回的模型目录中，请先刷新。",
    session_id_acp_provider_not_configured: "先确认 Provider CLI 与登录源。",
  };
  return messages[value] ?? value;
}

function messageFor(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
