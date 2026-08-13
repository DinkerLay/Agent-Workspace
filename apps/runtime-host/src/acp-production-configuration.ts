import {
  validateMetaProfileDefinitionV3,
  type MetaProfileDefinitionV3,
  type MetaProfileOptionId,
} from "@agent-workspace/runtime-contracts";

export const RUNTIME_ACP_CONFIGURATION_ENV = "AGENT_WORKSPACE_ACP_CONFIG";

const ENVIRONMENT_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

type HostEnvironment = Readonly<Record<string, string | undefined>>;

export type AcpProductionEnvironmentReference = Readonly<{ readonly env: string }>;

export type AcpProductionOpenCodeAgentConfiguration = Readonly<{
  readonly kind: "opencode-acp-current-install";
  readonly command: AcpProductionEnvironmentReference;
  readonly executableSearchPath: AcpProductionEnvironmentReference;
  readonly authFile: AcpProductionEnvironmentReference;
}>;

export type AcpProductionCodexAgentConfiguration = Readonly<{
  readonly kind: "codex-acp-current-install";
  readonly wrapperCommand: AcpProductionEnvironmentReference;
  readonly codexCommand: AcpProductionEnvironmentReference;
  readonly nodeCommand: AcpProductionEnvironmentReference;
  readonly executableSearchPath: AcpProductionEnvironmentReference;
  readonly authFile: AcpProductionEnvironmentReference;
}>;

export type AcpProductionClaudeCodeAgentConfiguration = Readonly<{
  readonly kind: "claude-agent-acp-current-install";
  readonly wrapperCommand: AcpProductionEnvironmentReference;
  readonly claudeCommand: AcpProductionEnvironmentReference;
  readonly nodeCommand: AcpProductionEnvironmentReference;
  readonly executableSearchPath: AcpProductionEnvironmentReference;
  /** Explicit Claude/CCSwitch settings source; ambient ~/.claude is never read. */
  readonly settingsFile: AcpProductionEnvironmentReference;
}>;

export type AcpProductionMetaProfileConfiguration = Readonly<{
  readonly metaProfileOptionId: MetaProfileOptionId;
  readonly title: string;
  readonly profile: MetaProfileDefinitionV3;
}>;

export type AcpProductionConfiguration = Readonly<{
  readonly schemaVersion: 1;
  readonly agents: Readonly<{
    readonly opencode?: AcpProductionOpenCodeAgentConfiguration;
    readonly codex?: AcpProductionCodexAgentConfiguration;
    readonly claudeCode?: AcpProductionClaudeCodeAgentConfiguration;
  }>;
  readonly metaProfiles: readonly AcpProductionMetaProfileConfiguration[];
}>;

export type AcpProductionOpenCodeHostInputs = Readonly<{
  readonly commandReference: string;
  readonly executableSearchPath: string;
  readonly authFile: string;
}>;

export type AcpProductionCodexHostInputs = Readonly<{
  readonly wrapperCommandReference: string;
  readonly codexCommandReference: string;
  readonly nodeCommandReference: string;
  readonly executableSearchPath: string;
  readonly authFile: string;
}>;

export type AcpProductionClaudeCodeHostInputs = Readonly<{
  readonly wrapperCommandReference: string;
  readonly claudeCommandReference: string;
  readonly nodeCommandReference: string;
  readonly executableSearchPath: string;
  readonly settingsFile: string;
}>;

export type AcpProductionHostInputs = Readonly<{
  openCode(): AcpProductionOpenCodeHostInputs | undefined;
  codex(): AcpProductionCodexHostInputs | undefined;
  claudeCode(): AcpProductionClaudeCodeHostInputs | undefined;
  toJSON(): Readonly<{ kind: "acp_production_host_inputs" }>;
}>;

export class AcpProductionConfigurationError extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, field?: string) {
    super(field ? `${code}:${field}` : code);
    this.name = "AcpProductionConfigurationError";
    this.code = code;
    this.field = field;
  }
}

const EMPTY_CONFIGURATION: AcpProductionConfiguration = Object.freeze({
  schemaVersion: 1 as const,
  agents: Object.freeze({}),
  metaProfiles: Object.freeze([]),
});

/**
 * Parses only Host discovery references and portable Meta Profiles. Local
 * command/auth values are deliberately not resolved here, so this object is
 * safe to retain as configuration intent and cannot serialize credentials or
 * machine paths. Current versions, digests, capabilities and qualifications
 * are observed later by the Host and are never accepted as configuration.
 */
export function parseAcpProductionConfiguration(
  serialized: string,
): AcpProductionConfiguration {
  if (typeof serialized !== "string" || !serialized.trim()) {
    throw configurationError("acp_production_configuration_missing");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw configurationError("acp_production_configuration_invalid_json");
  }
  return normalizeConfiguration(value);
}

/** Missing configuration starts a Host with no locally configured ACP Agent. */
export function loadAcpProductionConfigurationFromEnvironment(
  environment: HostEnvironment = process.env,
): AcpProductionConfiguration {
  const serialized = environment[RUNTIME_ACP_CONFIGURATION_ENV];
  if (serialized === undefined || !serialized.trim()) return EMPTY_CONFIGURATION;
  return parseAcpProductionConfiguration(serialized);
}

/**
 * Resolves configured environment references exactly once at Host startup.
 * Values remain behind Host-only methods and `toJSON` is deliberately redacted.
 * Filesystem/trust validation is owned by the current-install descriptors.
 */
export function createAcpProductionHostInputs(
  configuration: AcpProductionConfiguration,
  environment: HostEnvironment = process.env,
): AcpProductionHostInputs {
  const normalized = normalizeConfiguration(configuration);
  const openCode = normalized.agents.opencode
    ? Object.freeze({
        commandReference: resolveEnvironmentValue(
          normalized.agents.opencode.command,
          environment,
          "agents.opencode.command",
        ),
        executableSearchPath: resolveEnvironmentValue(
          normalized.agents.opencode.executableSearchPath,
          environment,
          "agents.opencode.executableSearchPath",
        ),
        authFile: resolveEnvironmentValue(
          normalized.agents.opencode.authFile,
          environment,
          "agents.opencode.authFile",
        ),
      })
    : undefined;
  const codex = normalized.agents.codex
    ? Object.freeze({
        wrapperCommandReference: resolveEnvironmentValue(
          normalized.agents.codex.wrapperCommand,
          environment,
          "agents.codex.wrapperCommand",
        ),
        codexCommandReference: resolveEnvironmentValue(
          normalized.agents.codex.codexCommand,
          environment,
          "agents.codex.codexCommand",
        ),
        nodeCommandReference: resolveEnvironmentValue(
          normalized.agents.codex.nodeCommand,
          environment,
          "agents.codex.nodeCommand",
        ),
        executableSearchPath: resolveEnvironmentValue(
          normalized.agents.codex.executableSearchPath,
          environment,
          "agents.codex.executableSearchPath",
        ),
        authFile: resolveEnvironmentValue(
          normalized.agents.codex.authFile,
          environment,
          "agents.codex.authFile",
        ),
      })
    : undefined;
  const claudeCode = normalized.agents.claudeCode
    ? Object.freeze({
        wrapperCommandReference: resolveEnvironmentValue(
          normalized.agents.claudeCode.wrapperCommand,
          environment,
          "agents.claudeCode.wrapperCommand",
        ),
        claudeCommandReference: resolveEnvironmentValue(
          normalized.agents.claudeCode.claudeCommand,
          environment,
          "agents.claudeCode.claudeCommand",
        ),
        nodeCommandReference: resolveEnvironmentValue(
          normalized.agents.claudeCode.nodeCommand,
          environment,
          "agents.claudeCode.nodeCommand",
        ),
        executableSearchPath: resolveEnvironmentValue(
          normalized.agents.claudeCode.executableSearchPath,
          environment,
          "agents.claudeCode.executableSearchPath",
        ),
        settingsFile: resolveEnvironmentValue(
          normalized.agents.claudeCode.settingsFile,
          environment,
          "agents.claudeCode.settingsFile",
        ),
      })
    : undefined;
  return Object.freeze({
    openCode: () => openCode,
    codex: () => codex,
    claudeCode: () => claudeCode,
    toJSON: () => Object.freeze({ kind: "acp_production_host_inputs" as const }),
  });
}

function normalizeConfiguration(value: unknown): AcpProductionConfiguration {
  const root = exactRecord(
    value,
    ["schemaVersion", "agents", "metaProfiles"],
    "acp_production_configuration_shape_invalid",
  );
  if (root.schemaVersion !== 1) {
    throw configurationError("acp_production_configuration_schema_unsupported", "schemaVersion");
  }
  const agentRoot = exactRecord(
    root.agents,
    ["opencode", "codex", "claudeCode"],
    "acp_production_agents_shape_invalid",
  );
  const agents = Object.freeze({
    ...(agentRoot.opencode === undefined
      ? {}
      : { opencode: normalizeOpenCodeAgent(agentRoot.opencode) }),
    ...(agentRoot.codex === undefined
      ? {}
      : { codex: normalizeCodexAgent(agentRoot.codex) }),
    ...(agentRoot.claudeCode === undefined
      ? {}
      : { claudeCode: normalizeClaudeCodeAgent(agentRoot.claudeCode) }),
  });
  if (!Array.isArray(root.metaProfiles)) {
    throw configurationError("acp_production_meta_profiles_invalid", "metaProfiles");
  }
  const seenOptionIds = new Set<string>();
  const seenProfileIds = new Set<string>();
  const seenRevisionIds = new Set<string>();
  const metaProfiles = root.metaProfiles.map((entry, index) => {
    const field = `metaProfiles[${index}]`;
    const record = exactRecord(
      entry,
      ["metaProfileOptionId", "title", "profile"],
      "acp_production_meta_profile_shape_invalid",
      field,
    );
    const metaProfileOptionId = requiredId(
      record.metaProfileOptionId,
      "meta_profile_option_",
      "acp_production_meta_profile_option_id_invalid",
      `${field}.metaProfileOptionId`,
    ) as MetaProfileOptionId;
    let profile: MetaProfileDefinitionV3;
    try {
      profile = deepFreeze(validateMetaProfileDefinitionV3(record.profile));
    } catch {
      throw configurationError("acp_production_meta_profile_invalid", `${field}.profile`);
    }
    if ((profile.providerFamily === "opencode" && profile.acpAgentKind !== "native_acp")
      || (profile.providerFamily === "codex" && profile.acpAgentKind !== "codex_acp")
      || (profile.providerFamily === "claude-code" && profile.acpAgentKind !== "claude_agent_acp")
      || !["opencode", "codex", "claude-code"].includes(profile.providerFamily)) {
      throw configurationError("acp_production_meta_profile_agent_mismatch", `${field}.profile`);
    }
    const configured = profile.providerFamily === "opencode"
      ? agents.opencode
      : profile.providerFamily === "codex"
        ? agents.codex
        : agents.claudeCode;
    if (!configured) {
      throw configurationError("acp_production_meta_profile_agent_not_configured", `${field}.profile`);
    }
    if (seenOptionIds.has(metaProfileOptionId)
      || seenProfileIds.has(profile.metaProfileId)
      || seenRevisionIds.has(profile.profileRevisionId)) {
      throw configurationError("acp_production_meta_profile_duplicate", field);
    }
    seenOptionIds.add(metaProfileOptionId);
    seenProfileIds.add(profile.metaProfileId);
    seenRevisionIds.add(profile.profileRevisionId);
    return Object.freeze({
      metaProfileOptionId,
      title: requiredText(record.title, 160, "acp_production_meta_profile_title_invalid", `${field}.title`),
      profile,
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    agents,
    metaProfiles: Object.freeze(metaProfiles),
  });
}

function normalizeOpenCodeAgent(value: unknown): AcpProductionOpenCodeAgentConfiguration {
  const field = "agents.opencode";
  const record = exactRecord(
    value,
    ["kind", "command", "executableSearchPath", "authFile"],
    "acp_production_opencode_agent_shape_invalid",
    field,
  );
  if (record.kind !== "opencode-acp-current-install") {
    throw configurationError("acp_production_opencode_agent_kind_invalid", `${field}.kind`);
  }
  return Object.freeze({
    kind: "opencode-acp-current-install" as const,
    command: environmentReference(record.command, `${field}.command`),
    executableSearchPath: environmentReference(
      record.executableSearchPath,
      `${field}.executableSearchPath`,
    ),
    authFile: environmentReference(record.authFile, `${field}.authFile`),
  });
}

function normalizeCodexAgent(value: unknown): AcpProductionCodexAgentConfiguration {
  const field = "agents.codex";
  const record = exactRecord(
    value,
    ["kind", "wrapperCommand", "codexCommand", "nodeCommand", "executableSearchPath", "authFile"],
    "acp_production_codex_agent_shape_invalid",
    field,
  );
  if (record.kind !== "codex-acp-current-install") {
    throw configurationError("acp_production_codex_agent_kind_invalid", `${field}.kind`);
  }
  return Object.freeze({
    kind: "codex-acp-current-install" as const,
    wrapperCommand: environmentReference(record.wrapperCommand, `${field}.wrapperCommand`),
    codexCommand: environmentReference(record.codexCommand, `${field}.codexCommand`),
    nodeCommand: environmentReference(record.nodeCommand, `${field}.nodeCommand`),
    executableSearchPath: environmentReference(
      record.executableSearchPath,
      `${field}.executableSearchPath`,
    ),
    authFile: environmentReference(record.authFile, `${field}.authFile`),
  });
}

function normalizeClaudeCodeAgent(value: unknown): AcpProductionClaudeCodeAgentConfiguration {
  const field = "agents.claudeCode";
  const record = exactRecord(
    value,
    [
      "kind",
      "wrapperCommand",
      "claudeCommand",
      "nodeCommand",
      "executableSearchPath",
      "settingsFile",
    ],
    "acp_production_claude_code_agent_shape_invalid",
    field,
  );
  if (record.kind !== "claude-agent-acp-current-install") {
    throw configurationError("acp_production_claude_code_agent_kind_invalid", `${field}.kind`);
  }
  return Object.freeze({
    kind: "claude-agent-acp-current-install" as const,
    wrapperCommand: environmentReference(record.wrapperCommand, `${field}.wrapperCommand`),
    claudeCommand: environmentReference(record.claudeCommand, `${field}.claudeCommand`),
    nodeCommand: environmentReference(record.nodeCommand, `${field}.nodeCommand`),
    executableSearchPath: environmentReference(
      record.executableSearchPath,
      `${field}.executableSearchPath`,
    ),
    settingsFile: environmentReference(record.settingsFile, `${field}.settingsFile`),
  });
}

function environmentReference(value: unknown, field: string): AcpProductionEnvironmentReference {
  const record = exactRecord(
    value,
    ["env"],
    "acp_production_environment_reference_invalid",
    field,
  );
  if (typeof record.env !== "string" || !ENVIRONMENT_VARIABLE.test(record.env)) {
    throw configurationError("acp_production_environment_reference_invalid", field);
  }
  return Object.freeze({ env: record.env });
}

function resolveEnvironmentValue(
  reference: AcpProductionEnvironmentReference,
  environment: HostEnvironment,
  field: string,
): string {
  const value = environment[reference.env];
  if (value === undefined || !value.trim()) {
    throw configurationError("acp_production_environment_reference_missing", field);
  }
  const normalized = value.trim();
  if (normalized.length > 32_768 || normalized.includes("\0")) {
    throw configurationError("acp_production_environment_reference_invalid", field);
  }
  return normalized;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
  field?: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw configurationError(code, field);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    throw configurationError(code, field);
  }
  return record;
}

function requiredId(
  value: unknown,
  prefix: string,
  code: string,
  field: string,
): string {
  const text = requiredText(value, 256, code, field);
  if (!text.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/u.test(text)) {
    throw configurationError(code, field);
  }
  return text;
}

function requiredText(
  value: unknown,
  maximum: number,
  code: string,
  field: string,
): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw configurationError(code, field);
  }
  return value.trim();
}

function configurationError(code: string, field?: string): AcpProductionConfigurationError {
  return new AcpProductionConfigurationError(code, field);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
