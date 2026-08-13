import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  AcpProfileModelCatalogEntry,
  AcpProviderInstallationDiscovery,
  AcpProviderInstallationInput,
  ProviderFamily,
} from "@agent-workspace/runtime-contracts";

const SETTINGS_FILE = "acp-provider-settings.json";
const SETTINGS_SCHEMA_VERSION = 3;
const MAX_SETTINGS_BYTES = 64 * 1024;
const PROVIDERS = Object.freeze(["opencode", "codex", "claude-code"] as const);

type HostEnvironment = NodeJS.ProcessEnv;
type StoredInstallation = AcpProviderInstallationInput;
type StoredProviderSettings = Readonly<{
  installation?: StoredInstallation;
  modelCatalog?: readonly AcpProfileModelCatalogEntry[];
  enabledChatModelIds?: readonly string[];
  defaultModelId?: string;
}>;
type StoredSettings = Readonly<{
  schemaVersion: 3;
  providers: Readonly<Partial<Record<ProviderFamily, StoredProviderSettings>>>;
}>;

export type SessionIdAcpProviderSetupSnapshot = Readonly<{
  configurationSource: "none" | "environment" | "local";
  installation: AcpProviderInstallationDiscovery;
  modelCatalog: readonly AcpProfileModelCatalogEntry[];
  enabledChatModelIds: readonly string[];
  defaultModelId?: string;
}>;

export type SessionIdAcpProviderSettingsHost = Readonly<{
  effectiveEnvironment(): HostEnvironment;
  read(providerFamily: ProviderFamily): SessionIdAcpProviderSetupSnapshot;
  discover(providerFamily: ProviderFamily): SessionIdAcpProviderSetupSnapshot;
  configure(providerFamily: ProviderFamily, installation: AcpProviderInstallationInput): SessionIdAcpProviderSetupSnapshot;
  recordModelCatalog(providerFamily: ProviderFamily, models: readonly AcpProfileModelCatalogEntry[]): SessionIdAcpProviderSetupSnapshot;
  configureChatModels(
    providerFamily: ProviderFamily,
    modelIds: readonly string[],
    defaultModelId: string,
  ): SessionIdAcpProviderSetupSnapshot;
  toJSON(): Readonly<{ kind: "session_id_acp_provider_settings_host" }>;
}>;

export function createSessionIdAcpProviderSettingsHost(options: Readonly<{
  runtimeDataDirectory: string;
  environment?: HostEnvironment;
}>): SessionIdAcpProviderSettingsHost {
  const environment = options.environment ?? process.env;
  const runtimeDataDirectory = requirePrivateDirectory(options.runtimeDataDirectory);
  const settingsPath = path.join(runtimeDataDirectory, SETTINGS_FILE);
  const environmentManaged = Boolean(environment.AGENT_WORKSPACE_ACP_CONFIG?.trim());
  let stored = readStoredSettings(settingsPath);
  const discoveries = new Map<ProviderFamily, AcpProviderInstallationDiscovery>();

  return Object.freeze({
    effectiveEnvironment: () => buildEffectiveEnvironment(environment, stored, environmentManaged),
    read(providerFamily) {
      return snapshot(providerFamily);
    },
    discover(providerFamily) {
      requireProviderFamily(providerFamily);
      discoveries.set(providerFamily, discoverProvider(providerFamily, environment, stored.providers[providerFamily]?.installation));
      return snapshot(providerFamily);
    },
    configure(providerFamily, installation) {
      requireProviderFamily(providerFamily);
      if (environmentManaged) throw new Error("session_id_acp_provider_environment_managed");
      const normalized = normalizeInstallation(providerFamily, installation, environment);
      stored = Object.freeze({
        schemaVersion: 3 as const,
        providers: Object.freeze({
          ...stored.providers,
          [providerFamily]: Object.freeze({
            ...stored.providers[providerFamily],
            installation: normalized,
          }),
        }),
      });
      writeStoredSettings(settingsPath, stored);
      discoveries.set(providerFamily, discoveryFromInstallation(normalized, "ready"));
      return snapshot(providerFamily);
    },
    recordModelCatalog(providerFamily, models) {
      requireProviderFamily(providerFamily);
      if (environmentManaged) return snapshot(providerFamily);
      const current = stored.providers[providerFamily];
      if (!current?.installation) throw new Error("session_id_acp_provider_installation_required");
      const modelCatalog = normalizeModelCatalog(models);
      stored = Object.freeze({
        schemaVersion: 3 as const,
        providers: Object.freeze({
          ...stored.providers,
          [providerFamily]: Object.freeze({ ...current, modelCatalog }),
        }),
      });
      writeStoredSettings(settingsPath, stored);
      return snapshot(providerFamily);
    },
    configureChatModels(providerFamily, modelIds, defaultModelId) {
      requireProviderFamily(providerFamily);
      if (environmentManaged) throw new Error("session_id_acp_provider_environment_managed");
      const current = stored.providers[providerFamily];
      if (!current?.installation) throw new Error("session_id_acp_provider_installation_required");
      const catalog = current.modelCatalog ?? Object.freeze([]);
      const observed = new Set(catalog.map((entry) => entry.modelId));
      const enabledChatModelIds = normalizeModelIds(modelIds);
      const normalizedDefault = normalizeModelId(defaultModelId);
      if (enabledChatModelIds.length === 0) throw new Error("session_id_acp_provider_chat_models_required");
      if (enabledChatModelIds.some((modelId) => !observed.has(modelId)) || !observed.has(normalizedDefault)) {
        throw new Error("session_id_acp_provider_model_not_observed");
      }
      if (!enabledChatModelIds.includes(normalizedDefault)) {
        throw new Error("session_id_acp_provider_default_model_not_enabled");
      }
      const ordered = Object.freeze([
        normalizedDefault,
        ...enabledChatModelIds.filter((modelId) => modelId !== normalizedDefault),
      ]);
      stored = Object.freeze({
        schemaVersion: 3 as const,
        providers: Object.freeze({
          ...stored.providers,
          [providerFamily]: Object.freeze({
            ...current,
            enabledChatModelIds: ordered,
            defaultModelId: normalizedDefault,
          }),
        }),
      });
      writeStoredSettings(settingsPath, stored);
      return snapshot(providerFamily);
    },
    toJSON: () => Object.freeze({ kind: "session_id_acp_provider_settings_host" as const }),
  });

  function snapshot(providerFamily: ProviderFamily): SessionIdAcpProviderSetupSnapshot {
    requireProviderFamily(providerFamily);
    const provider = stored.providers[providerFamily];
    return Object.freeze({
      configurationSource: environmentManaged
        ? "environment" as const
        : provider?.installation
          ? "local" as const
          : "none" as const,
      installation: discoveries.get(providerFamily)
        ?? (provider?.installation
          ? discoveryFromInstallation(provider.installation, "ready")
          : Object.freeze({ status: "not_scanned" as const, components: Object.freeze([]) })),
      modelCatalog: Object.freeze([...(provider?.modelCatalog ?? [])]),
      enabledChatModelIds: Object.freeze([...(provider?.enabledChatModelIds ?? [])]),
      ...(provider?.defaultModelId ? { defaultModelId: provider.defaultModelId } : {}),
    });
  }
}

function discoverProvider(
  providerFamily: ProviderFamily,
  environment: HostEnvironment,
  stored?: StoredInstallation,
): AcpProviderInstallationDiscovery {
  if (stored) return discoveryFromInstallation(stored, "ready");
  const home = environment.HOME?.trim();
  const searchPath = environment.PATH ?? "";
  if (providerFamily === "opencode") {
    return discoveryFromPaths([
      component("provider_cli", "OpenCode CLI", findCommand("opencode", searchPath)),
      component("credential_source", "OpenCode 登录", home ? path.join(home, ".local/share/opencode/auth.json") : undefined),
    ]);
  }
  if (providerFamily === "codex") {
    return discoveryFromPaths([
      component("provider_cli", "Codex CLI", findCommand("codex", searchPath)),
      component("node", "Node.js", findCommand("node", searchPath)),
      component("credential_source", "Codex 登录", home ? path.join(home, ".codex/auth.json") : undefined),
    ]);
  }
  return discoveryFromPaths([
    component("provider_cli", "Claude Code CLI", findCommand("claude", searchPath)),
    component("node", "Node.js", findCommand("node", searchPath)),
    component("credential_source", "Claude/CCSwitch 设置", home ? path.join(home, ".claude/settings.json") : undefined),
  ]);
}

function component(
  kind: "provider_cli" | "node" | "credential_source",
  label: string,
  candidate?: string,
) {
  const found = candidate ? safeCanonicalFile(candidate) : undefined;
  return Object.freeze({
    kind,
    label,
    status: found ? "found" as const : "missing" as const,
    ...(found ? { displayPath: displayPath(found) } : {}),
  });
}

function discoveryFromPaths(
  components: readonly ReturnType<typeof component>[],
): AcpProviderInstallationDiscovery {
  const found = components.filter((entry) => entry.status === "found").length;
  return Object.freeze({
    status: found === components.length ? "ready" as const : found > 0 ? "incomplete" as const : "not_found" as const,
    components: Object.freeze([...components]),
  });
}

function discoveryFromInstallation(
  installation: StoredInstallation,
  status: "ready",
): AcpProviderInstallationDiscovery {
  const paths = installation.kind === "opencode"
    ? [
        component("provider_cli", "OpenCode CLI", installation.commandPath),
        component("credential_source", "OpenCode 登录", installation.authFilePath),
      ]
    : installation.kind === "codex"
      ? [
          component("provider_cli", "Codex CLI", installation.codexPath),
          component("node", "Node.js", installation.nodePath),
          component("credential_source", "Codex 登录", installation.authFilePath),
        ]
      : [
          component("provider_cli", "Claude Code CLI", installation.claudePath),
          component("node", "Node.js", installation.nodePath),
          component("credential_source", "Claude/CCSwitch 设置", installation.settingsFilePath),
        ];
  return Object.freeze({ status, components: Object.freeze(paths) });
}

function normalizeInstallation(
  providerFamily: ProviderFamily,
  value: AcpProviderInstallationInput,
  environment: HostEnvironment,
): StoredInstallation {
  if (providerFamily !== value.kind) throw new Error("session_id_acp_provider_installation_scope_mismatch");
  if (value.kind === "opencode") {
    return Object.freeze({
      kind: "opencode" as const,
      commandPath: trustedFile(value.commandPath, environment, "commandPath"),
      authFilePath: trustedFile(value.authFilePath, environment, "authFilePath"),
    });
  }
  if (value.kind === "codex") {
    return Object.freeze({
      kind: "codex" as const,
      codexPath: trustedFile(value.codexPath, environment, "codexPath"),
      nodePath: trustedFile(value.nodePath, environment, "nodePath"),
      authFilePath: trustedFile(value.authFilePath, environment, "authFilePath"),
    });
  }
  return Object.freeze({
    kind: "claude-code" as const,
    claudePath: trustedFile(value.claudePath, environment, "claudePath"),
    nodePath: trustedFile(value.nodePath, environment, "nodePath"),
    settingsFilePath: trustedFile(value.settingsFilePath, environment, "settingsFilePath"),
  });
}

function buildEffectiveEnvironment(
  environment: HostEnvironment,
  settings: StoredSettings,
  environmentManaged: boolean,
): HostEnvironment {
  if (environmentManaged) return Object.freeze({ ...environment });
  const next: HostEnvironment = { ...environment };
  const agents: Record<string, unknown> = {};
  const metaProfiles: unknown[] = [];
  for (const providerFamily of PROVIDERS) {
    const provider = settings.providers[providerFamily];
    if (!provider?.installation) continue;
    const searchPath = installationSearchPath(provider.installation, environment.PATH ?? "");
    if (provider.installation.kind === "opencode") {
      next.AGENT_WORKSPACE_LOCAL_OPENCODE_COMMAND = provider.installation.commandPath;
      next.AGENT_WORKSPACE_LOCAL_OPENCODE_AUTH = provider.installation.authFilePath;
      next.AGENT_WORKSPACE_LOCAL_OPENCODE_SEARCH_PATH = searchPath;
      agents.opencode = {
        kind: "opencode-acp-current-install",
        command: { env: "AGENT_WORKSPACE_LOCAL_OPENCODE_COMMAND" },
        executableSearchPath: { env: "AGENT_WORKSPACE_LOCAL_OPENCODE_SEARCH_PATH" },
        authFile: { env: "AGENT_WORKSPACE_LOCAL_OPENCODE_AUTH" },
      };
    } else if (provider.installation.kind === "codex") {
      next.AGENT_WORKSPACE_LOCAL_CODEX_ACP_WRAPPER = managedAcpEntry("codex");
      next.AGENT_WORKSPACE_LOCAL_CODEX_COMMAND = provider.installation.codexPath;
      next.AGENT_WORKSPACE_LOCAL_CODEX_NODE = provider.installation.nodePath;
      next.AGENT_WORKSPACE_LOCAL_CODEX_AUTH = provider.installation.authFilePath;
      next.AGENT_WORKSPACE_LOCAL_CODEX_SEARCH_PATH = searchPath;
      agents.codex = {
        kind: "codex-acp-current-install",
        wrapperCommand: { env: "AGENT_WORKSPACE_LOCAL_CODEX_ACP_WRAPPER" },
        codexCommand: { env: "AGENT_WORKSPACE_LOCAL_CODEX_COMMAND" },
        nodeCommand: { env: "AGENT_WORKSPACE_LOCAL_CODEX_NODE" },
        executableSearchPath: { env: "AGENT_WORKSPACE_LOCAL_CODEX_SEARCH_PATH" },
        authFile: { env: "AGENT_WORKSPACE_LOCAL_CODEX_AUTH" },
      };
    } else {
      next.AGENT_WORKSPACE_LOCAL_CLAUDE_ACP_WRAPPER = managedAcpEntry("claude-code");
      next.AGENT_WORKSPACE_LOCAL_CLAUDE_COMMAND = provider.installation.claudePath;
      next.AGENT_WORKSPACE_LOCAL_CLAUDE_NODE = provider.installation.nodePath;
      next.AGENT_WORKSPACE_LOCAL_CLAUDE_SETTINGS = provider.installation.settingsFilePath;
      next.AGENT_WORKSPACE_LOCAL_CLAUDE_SEARCH_PATH = searchPath;
      agents.claudeCode = {
        kind: "claude-agent-acp-current-install",
        wrapperCommand: { env: "AGENT_WORKSPACE_LOCAL_CLAUDE_ACP_WRAPPER" },
        claudeCommand: { env: "AGENT_WORKSPACE_LOCAL_CLAUDE_COMMAND" },
        nodeCommand: { env: "AGENT_WORKSPACE_LOCAL_CLAUDE_NODE" },
        executableSearchPath: { env: "AGENT_WORKSPACE_LOCAL_CLAUDE_SEARCH_PATH" },
        settingsFile: { env: "AGENT_WORKSPACE_LOCAL_CLAUDE_SETTINGS" },
      };
    }
    for (const modelId of provider.enabledChatModelIds ?? []) {
      for (const effort of metaProfileEfforts(providerFamily)) {
        metaProfiles.push(metaProfile(providerFamily, modelId, effort));
      }
    }
  }
  if (Object.keys(agents).length) {
    next.AGENT_WORKSPACE_ACP_CONFIG = JSON.stringify({ schemaVersion: 1, agents, metaProfiles });
  }
  return Object.freeze(next);
}

function metaProfile(providerFamily: ProviderFamily, model: string, effort: string) {
  const stem = providerFamily === "claude-code" ? "claude-code" : providerFamily;
  const digest = createHash("sha256").update(`${model}\0${effort}`).digest("hex").slice(0, 16);
  const effortSuffix = effort === "default" ? "" : ` · ${effort}`;
  return {
    metaProfileOptionId: `meta_profile_option_user-${stem}-${digest}`,
    title: `${providerTitle(providerFamily)} · ${model}${effortSuffix}`,
    profile: {
      metaProfileId: `meta_profile_user-${stem}-${digest}`,
      profileRevisionId: `profile_revision_user-meta-${stem}-${digest}-v1`,
      providerFamily,
      acpAgentKind: providerFamily === "opencode" ? "native_acp" : providerFamily === "codex" ? "codex_acp" : "claude_agent_acp",
      protocolMajor: 1,
      role: "meta",
      model,
      configIntent: effort === "default" ? {} : { reasoningEffort: effort },
      requiredExtensions: [],
      capabilityPolicy: {
        requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
        allowedTools: [],
        permissionMode: "deny",
        maxConcurrentTurns: 1,
        maxNativeChildren: 0,
      },
    },
  };
}

function installationSearchPath(installation: StoredInstallation, inherited: string): string {
  const paths = installation.kind === "opencode"
    ? [installation.commandPath]
    : installation.kind === "codex"
      ? [installation.codexPath, installation.nodePath]
      : [installation.claudePath, installation.nodePath];
  return [...new Set([...paths.map((entry) => path.dirname(entry)), ...inherited.split(path.delimiter).filter(Boolean)])]
    .join(path.delimiter);
}

function readStoredSettings(filePath: string): StoredSettings {
  if (!existsSync(filePath)) return emptySettings();
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
    || before.size < 1 || before.size > MAX_SETTINGS_BYTES) {
    throw new Error("session_id_acp_provider_settings_file_unsafe");
  }
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollow());
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error("session_id_acp_provider_settings_file_unsafe");
    }
    return normalizeStoredSettings(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("session_id_acp_provider_settings_invalid");
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function writeStoredSettings(filePath: string, settings: StoredSettings): void {
  const temporary = `${filePath}.tmp-${randomBytes(12).toString("hex")}`;
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(settings)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, filePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort exact temporary cleanup */ }
    throw error;
  }
}

function normalizeStoredSettings(value: unknown): StoredSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_id_acp_provider_settings_invalid");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(",") !== "providers,schemaVersion"
    || (root.schemaVersion !== 1 && root.schemaVersion !== 2 && root.schemaVersion !== SETTINGS_SCHEMA_VERSION)
    || !root.providers || typeof root.providers !== "object" || Array.isArray(root.providers)) {
    throw new Error("session_id_acp_provider_settings_invalid");
  }
  const providerRoot = root.providers as Record<string, unknown>;
  if (Object.keys(providerRoot).some((key) => !PROVIDERS.includes(key as ProviderFamily))) {
    throw new Error("session_id_acp_provider_settings_invalid");
  }
  const providers: Partial<Record<ProviderFamily, StoredProviderSettings>> = {};
  for (const providerFamily of PROVIDERS) {
    const entry = providerRoot[providerFamily];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("session_id_acp_provider_settings_invalid");
    const record = entry as Record<string, unknown>;
    const allowedKeys = root.schemaVersion === 3
      ? ["installation", "modelCatalog", "enabledChatModelIds", "defaultModelId"]
      : ["installation", "defaultModelId"];
    if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
      throw new Error("session_id_acp_provider_settings_invalid");
    }
    const installation = normalizeStoredInstallation(providerFamily, record.installation, root.schemaVersion);
    const defaultModelId = record.defaultModelId === undefined ? undefined : requiredText(record.defaultModelId, "session_id_acp_provider_settings_invalid");
    const modelCatalog = root.schemaVersion === 3
      ? normalizeModelCatalog(record.modelCatalog ?? [])
      : Object.freeze([]);
    const enabledChatModelIds = root.schemaVersion === 3
      ? normalizeModelIds(record.enabledChatModelIds ?? [])
      : defaultModelId ? Object.freeze([defaultModelId]) : Object.freeze([]);
    providers[providerFamily] = Object.freeze({
      installation,
      modelCatalog,
      enabledChatModelIds,
      ...(defaultModelId ? { defaultModelId } : {}),
    });
  }
  return Object.freeze({ schemaVersion: 3 as const, providers: Object.freeze(providers) });
}

function normalizeStoredInstallation(
  providerFamily: ProviderFamily,
  value: unknown,
  schemaVersion: 1 | 2 | 3,
): StoredInstallation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_id_acp_provider_settings_invalid");
  const record = value as Record<string, unknown>;
  if (providerFamily === "opencode") {
    exactKeys(record, ["kind", "commandPath", "authFilePath"]);
    if (record.kind !== "opencode") throw new Error("session_id_acp_provider_settings_invalid");
    return Object.freeze({ kind: "opencode", commandPath: requiredText(record.commandPath), authFilePath: requiredText(record.authFilePath) });
  }
  if (providerFamily === "codex") {
    exactKeys(record, schemaVersion === 1
      ? ["kind", "wrapperPath", "codexPath", "nodePath", "authFilePath"]
      : ["kind", "codexPath", "nodePath", "authFilePath"]);
    if (record.kind !== "codex") throw new Error("session_id_acp_provider_settings_invalid");
    return Object.freeze({ kind: "codex", codexPath: requiredText(record.codexPath), nodePath: requiredText(record.nodePath), authFilePath: requiredText(record.authFilePath) });
  }
  exactKeys(record, schemaVersion === 1
    ? ["kind", "wrapperPath", "claudePath", "nodePath", "settingsFilePath"]
    : ["kind", "claudePath", "nodePath", "settingsFilePath"]);
  if (record.kind !== "claude-code") throw new Error("session_id_acp_provider_settings_invalid");
  return Object.freeze({ kind: "claude-code", claudePath: requiredText(record.claudePath), nodePath: requiredText(record.nodePath), settingsFilePath: requiredText(record.settingsFilePath) });
}

function trustedFile(value: string, environment: HostEnvironment, field: string): string {
  const expanded = expandHome(requiredText(value, `session_id_acp_provider_${field}_invalid`), environment.HOME);
  if (!path.isAbsolute(expanded)) throw new Error(`session_id_acp_provider_${field}_invalid`);
  let canonical: string;
  try { canonical = realpathSync(expanded); } catch { throw new Error(`session_id_acp_provider_${field}_missing`); }
  const selected = statSync(canonical);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!selected.isFile() || (selected.mode & 0o022) !== 0 || (uid !== undefined && selected.uid !== uid && selected.uid !== 0)) {
    throw new Error(`session_id_acp_provider_${field}_untrusted`);
  }
  return canonical;
}

function safeCanonicalFile(value: string): string | undefined {
  try {
    const canonical = realpathSync(value);
    return statSync(canonical).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function findCommand(name: string, searchPath: string): string | undefined {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    const canonical = safeCanonicalFile(candidate);
    if (canonical) return canonical;
  }
  return undefined;
}

function displayPath(value: string): string {
  const home = process.env.HOME ? safeCanonicalDirectory(process.env.HOME) : undefined;
  return home && (value === home || value.startsWith(`${home}${path.sep}`))
    ? `~${value.slice(home.length)}`
    : value;
}

function safeCanonicalDirectory(value: string): string | undefined {
  try { return realpathSync(value); } catch { return undefined; }
}

function requirePrivateDirectory(value: string): string {
  const requested = path.resolve(requiredText(value, "session_id_acp_provider_settings_root_required"));
  if (!existsSync(requested)) mkdirSync(requested, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(requested);
  const selected = lstatSync(canonical);
  if (!selected.isDirectory() || selected.isSymbolicLink() || (selected.mode & 0o777) !== 0o700) {
    throw new Error("session_id_acp_provider_settings_root_unsafe");
  }
  return canonical;
}

function expandHome(value: string, home?: string): string {
  return value === "~" && home ? home : value.startsWith("~/") && home ? path.join(home, value.slice(2)) : value;
}

function emptySettings(): StoredSettings {
  return Object.freeze({ schemaVersion: 3 as const, providers: Object.freeze({}) });
}

function normalizeModelCatalog(value: unknown): readonly AcpProfileModelCatalogEntry[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error("session_id_acp_provider_model_catalog_invalid");
  const normalized = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("session_id_acp_provider_model_catalog_invalid");
    }
    exactKeys(entry as Record<string, unknown>, ["modelId", "label"]);
    const modelId = normalizeModelId((entry as Record<string, unknown>).modelId);
    const label = requiredText((entry as Record<string, unknown>).label, "session_id_acp_provider_model_catalog_invalid");
    if (label.length > 256 || /[\r\n\0]/u.test(label)) throw new Error("session_id_acp_provider_model_catalog_invalid");
    return Object.freeze({ modelId, label });
  });
  if (new Set(normalized.map((entry) => entry.modelId)).size !== normalized.length) {
    throw new Error("session_id_acp_provider_model_catalog_invalid");
  }
  return Object.freeze(normalized);
}

function normalizeModelIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error("session_id_acp_provider_model_invalid");
  const normalized = value.map(normalizeModelId);
  if (new Set(normalized).size !== normalized.length) throw new Error("session_id_acp_provider_model_invalid");
  return Object.freeze(normalized);
}

function normalizeModelId(value: unknown): string {
  const modelId = requiredText(value, "session_id_acp_provider_model_invalid");
  if (modelId.length > 256 || /[\r\n\0]/u.test(modelId)) throw new Error("session_id_acp_provider_model_invalid");
  return modelId;
}

function metaProfileEfforts(providerFamily: ProviderFamily): readonly string[] {
  return providerFamily === "codex"
    ? Object.freeze(["default", "low", "medium", "high", "xhigh"])
    : Object.freeze(["default"]);
}

const moduleRequire = createRequire(import.meta.url);
const MANAGED_ACP_ENTRIES = Object.freeze({
  codex: realpathSync(moduleRequire.resolve("@agentclientprotocol/codex-acp")),
  "claude-code": realpathSync(moduleRequire.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js")),
});

function managedAcpEntry(providerFamily: "codex" | "claude-code"): string {
  return MANAGED_ACP_ENTRIES[providerFamily];
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error("session_id_acp_provider_settings_invalid");
}

function requiredText(value: unknown, code = "session_id_acp_provider_settings_invalid"): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(code);
  return value.trim();
}

function requireProviderFamily(value: ProviderFamily): void {
  if (!PROVIDERS.includes(value)) throw new Error("session_id_acp_provider_family_invalid");
}

function providerTitle(value: ProviderFamily): string {
  return value === "opencode" ? "OpenCode" : value === "codex" ? "Codex" : "Claude Code";
}

function noFollow(): number {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("session_id_acp_provider_no_follow_unavailable");
  return constants.O_NOFOLLOW;
}
