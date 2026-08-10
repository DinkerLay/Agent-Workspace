import { isAbsolute, join } from "node:path";
import {
  createClaudeCodeProviderAdapter,
} from "@agent-workspace/provider-claude-code";
import {
  CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
  createCodexAppServerProviderAdapter,
} from "@agent-workspace/provider-codex";
import {
  createOpenCodeProviderAdapter,
  createOpenCodeServerTransport,
} from "@agent-workspace/provider-opencode";
import type { ProviderKind } from "@agent-workspace/runtime-contracts";
import {
  type ProtocolPin,
  type ProviderPort,
} from "@agent-workspace/provider-port";
import { createClaudeCodeStreamTransport } from "./claude-code-stream-bridge.js";
import { createCodexAppServerConnectionFactory } from "./codex-app-server-bridge.js";

/** JSON stored in this Host-only environment variable selects live Provider ports. */
export const RUNTIME_PROVIDER_CONFIGURATION_ENV = "AGENT_WORKSPACE_PROVIDER_CONFIG";

const SUPPORTED_PROVIDERS = new Set<ProviderKind>(["opencode", "codex", "claude-code"]);
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type HostEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Secrets are named here and resolved only inside Runtime Host composition.
 * The resolved value is never retained in the returned configuration object.
 */
export type HostEnvironmentReference = Readonly<{ readonly env: string }>;

/** Direct, version-pinned OpenCode Server REST transport. */
export type OpenCodeServerTransportConfiguration = Readonly<{
  readonly kind: "opencode-server";
  readonly baseUrl: string | HostEnvironmentReference;
  readonly headers?: Readonly<Record<string, HostEnvironmentReference>>;
}>;

/**
 * Direct, persistent Codex App Server. Its process is owned by Runtime Host;
 * this configuration names only an executable and an explicit child-env
 * allowlist. The protocol probe cwd and all journals remain Host private.
 */
export type CodexAppServerTransportConfiguration = Readonly<{
  readonly kind: "codex-app-server";
  readonly command: string | HostEnvironmentReference;
  readonly env: Readonly<Record<string, HostEnvironmentReference>>;
}>;

/** Direct, persistent Claude Code stream-json CLI. */
export type ClaudeCodeStreamTransportConfiguration = Readonly<{
  readonly kind: "claude-code-stream";
  readonly command: string | HostEnvironmentReference;
  readonly env: Readonly<Record<string, HostEnvironmentReference>>;
}>;

export type RuntimeProviderTransportConfiguration =
  | OpenCodeServerTransportConfiguration
  | CodexAppServerTransportConfiguration
  | ClaudeCodeStreamTransportConfiguration;

export type RuntimeProviderConfigurationEntry = Readonly<{
  readonly provider: ProviderKind;
  /** A version-spike pin. Fixture pins and unpinned protocols are not a production fallback. */
  readonly protocol: ProtocolPin;
  readonly transport: RuntimeProviderTransportConfiguration;
}>;

export type RuntimeProviderConfiguration = Readonly<{
  readonly schemaVersion: 1;
  readonly providers: readonly RuntimeProviderConfigurationEntry[];
}>;

export type RuntimeProviderCompositionOptions = Readonly<{
  readonly environment?: HostEnvironment;
  readonly fetchFn?: typeof fetch;
  /**
   * Runtime Host's already-owned private data directory. Native process bridges
   * derive probe cwd and frame journals beneath it instead of accepting those
   * paths from a Template, renderer, or Provider configuration.
   */
  readonly runtimeDataDirectory?: string;
}>;

export type RuntimeProviderEnvironmentLoaderOptions = RuntimeProviderCompositionOptions & Readonly<{
  readonly configurationEnvironmentVariable?: string;
}>;

/** Errors intentionally name only a safe field or environment-variable identifier. */
export class RuntimeProviderConfigurationError extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, field?: string) {
    super(field ? `${code}: ${field}` : code);
    this.name = "RuntimeProviderConfigurationError";
    this.code = code;
    this.field = field;
  }
}

/**
 * Parses the small, explicit Host configuration. It accepts no fixture
 * transport and requires a declared protocol pin for every registered port.
 */
export function parseRuntimeProviderConfiguration(serialized: string): RuntimeProviderConfiguration {
  if (typeof serialized !== "string" || !serialized.trim()) {
    throw configurationError("runtime_provider_configuration_missing");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw configurationError("runtime_provider_configuration_invalid_json");
  }
  return normalizeRuntimeProviderConfiguration(value);
}

/**
 * Builds only the Provider ports explicitly listed in configuration. The
 * RuntimeApplication registry therefore treats every omitted provider as
 * unavailable rather than substituting a fixture or default transport.
 */
export function createRuntimeProviderPorts(
  configuration: RuntimeProviderConfiguration,
  options: RuntimeProviderCompositionOptions = {},
): readonly ProviderPort[] {
  const normalized = normalizeRuntimeProviderConfiguration(configuration);
  const environment = options.environment ?? process.env;
  const ports = normalized.providers.map((entry) => createPort(entry, environment, options));
  return Object.freeze(ports);
}

/**
 * Loads the JSON configuration from Host environment. An unset or blank value
 * deliberately registers no Provider ports; it never creates a fake fallback.
 */
export function loadRuntimeProviderPortsFromEnvironment(
  options: RuntimeProviderEnvironmentLoaderOptions = {},
): readonly ProviderPort[] {
  const environment = options.environment ?? process.env;
  const variable = options.configurationEnvironmentVariable ?? RUNTIME_PROVIDER_CONFIGURATION_ENV;
  assertEnvironmentVariableName(variable, "configurationEnvironmentVariable");
  const serialized = environment[variable];
  if (serialized === undefined || !serialized.trim()) return Object.freeze([]);
  return createRuntimeProviderPorts(parseRuntimeProviderConfiguration(serialized), options);
}

function createPort(
  entry: RuntimeProviderConfigurationEntry,
  environment: HostEnvironment,
  options: RuntimeProviderCompositionOptions,
): ProviderPort {
  if (entry.transport.kind === "codex-app-server") {
    if (entry.provider !== "codex") {
      throw configurationError("runtime_provider_configuration_transport_provider_mismatch", "transport.kind");
    }
    const runtimeDataDirectory = requireRuntimeDataDirectory(options);
    const connectionFactory = createCodexAppServerConnectionFactory({
      command: resolveReferenceableString(entry.transport.command, environment),
      cwd: runtimeDataDirectory,
      environment: resolveReferenceRecord(entry.transport.env, environment),
      protocol: entry.protocol,
      protocolDirectory: join(runtimeDataDirectory, "provider-protocol", "codex"),
    });
    return createCodexAppServerProviderAdapter({
      connectionFactory,
      protocol: entry.protocol,
      safety: { approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false },
      verifiedCapabilities: CODEX_APP_SERVER_PROVEN_CORE_CAPABILITIES,
    });
  }
  if (entry.transport.kind === "claude-code-stream") {
    if (entry.provider !== "claude-code") {
      throw configurationError("runtime_provider_configuration_transport_provider_mismatch", "transport.kind");
    }
    const runtimeDataDirectory = requireRuntimeDataDirectory(options);
    const transport = createClaudeCodeStreamTransport({
      command: resolveReferenceableString(entry.transport.command, environment),
      environment: resolveReferenceRecord(entry.transport.env, environment),
      journalDirectory: join(runtimeDataDirectory, "provider-journals", "claude-code"),
      protocolFingerprint: entry.protocol.protocolFingerprint,
    });
    const adapter = createClaudeCodeProviderAdapter({ transport, protocol: entry.protocol });
    return Object.freeze({ ...adapter, close: () => transport.close() });
  }
  if (entry.provider !== "opencode" || entry.transport.kind !== "opencode-server") {
    throw configurationError("runtime_provider_configuration_transport_provider_mismatch", "transport.kind");
  }
  return createOpenCodeProviderAdapter({
    transport: createOpenCodeServerTransport(resolveOpenCodeServerTransport(entry.transport, environment, options.fetchFn)),
    protocol: entry.protocol,
  });
}

function resolveOpenCodeServerTransport(
  configuration: OpenCodeServerTransportConfiguration,
  environment: HostEnvironment,
  fetchFn: typeof fetch | undefined,
): Parameters<typeof createOpenCodeServerTransport>[0] {
  const baseUrl = resolveReferenceableString(configuration.baseUrl, environment);
  assertHttpBaseUrl(baseUrl);
  const headers = resolveReferenceRecord(configuration.headers, environment);
  return {
    baseUrl,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(fetchFn ? { fetchFn } : {}),
  };
}

function normalizeRuntimeProviderConfiguration(value: unknown): RuntimeProviderConfiguration {
  const record = requiredRecord(value, "configuration");
  assertOnlyKeys(record, ["schemaVersion", "providers"], "configuration");
  if (record.schemaVersion !== 1) throw configurationError("runtime_provider_configuration_schema_unsupported", "schemaVersion");
  if (!Array.isArray(record.providers)) throw configurationError("runtime_provider_configuration_invalid", "providers");
  const seenProviders = new Set<ProviderKind>();
  const providers = record.providers.map((provider, index) => {
    const entry = parseProviderEntry(provider, `providers[${index}]`);
    if (seenProviders.has(entry.provider)) throw configurationError("runtime_provider_configuration_duplicate_provider", "providers");
    seenProviders.add(entry.provider);
    return entry;
  });
  return Object.freeze({ schemaVersion: 1, providers: Object.freeze(providers) });
}

function parseProviderEntry(value: unknown, field: string): RuntimeProviderConfigurationEntry {
  const record = requiredRecord(value, field);
  assertOnlyKeys(record, ["provider", "protocol", "transport"], field);
  const provider = requiredString(record.provider, `${field}.provider`) as ProviderKind;
  if (!SUPPORTED_PROVIDERS.has(provider)) throw configurationError("runtime_provider_configuration_provider_unsupported", `${field}.provider`);
  const protocol = parseProtocol(record.protocol, `${field}.protocol`);
  const transport = parseTransport(record.transport, `${field}.transport`);
  return Object.freeze({
    provider,
    protocol,
    transport,
  });
}

function parseProtocol(value: unknown, field: string): ProtocolPin {
  const record = requiredRecord(value, field);
  assertOnlyKeys(record, ["providerVersion", "protocolFingerprint"], field);
  return Object.freeze({
    providerVersion: requiredString(record.providerVersion, `${field}.providerVersion`),
    protocolFingerprint: requiredString(record.protocolFingerprint, `${field}.protocolFingerprint`),
  });
}

function parseTransport(value: unknown, field: string): RuntimeProviderTransportConfiguration {
  const record = requiredRecord(value, field);
  const kind = requiredString(record.kind, `${field}.kind`);
  if (kind === "opencode-server") {
    assertOnlyKeys(record, ["kind", "baseUrl", "headers"], field);
    return Object.freeze({
      kind,
      baseUrl: parseReferenceableString(record.baseUrl, `${field}.baseUrl`),
      ...(record.headers === undefined ? {} : { headers: parseReferenceRecord(record.headers, `${field}.headers`, assertHttpHeaderName) }),
    });
  }
  if (kind === "codex-app-server") {
    assertOnlyKeys(record, ["kind", "command", "env"], field);
    return Object.freeze({
      kind,
      command: parseReferenceableString(record.command, `${field}.command`),
      env: parseReferenceRecord(record.env, `${field}.env`, assertEnvironmentVariableName),
    });
  }
  if (kind === "claude-code-stream") {
    assertOnlyKeys(record, ["kind", "command", "env"], field);
    return Object.freeze({
      kind,
      command: parseReferenceableString(record.command, `${field}.command`),
      env: parseReferenceRecord(record.env, `${field}.env`, assertEnvironmentVariableName),
    });
  }
  throw configurationError("runtime_provider_configuration_transport_unsupported", `${field}.kind`);
}

function requireRuntimeDataDirectory(options: RuntimeProviderCompositionOptions): string {
  const directory = options.runtimeDataDirectory;
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw configurationError("runtime_provider_configuration_runtime_data_directory_required", "runtimeDataDirectory");
  }
  return directory;
}

function parseReferenceRecord(
  value: unknown,
  field: string,
  validateKey: (value: string, field: string) => void,
): Readonly<Record<string, HostEnvironmentReference>> {
  const record = requiredRecord(value, field);
  const references: Record<string, HostEnvironmentReference> = Object.create(null) as Record<string, HostEnvironmentReference>;
  for (const [key, reference] of Object.entries(record)) {
    validateKey(key, field);
    references[key] = parseEnvironmentReference(reference, field);
  }
  return Object.freeze(references);
}

function parseReferenceableString(value: unknown, field: string): string | HostEnvironmentReference {
  return typeof value === "string" ? requiredString(value, field) : parseEnvironmentReference(value, field);
}

function parseEnvironmentReference(value: unknown, field: string): HostEnvironmentReference {
  const record = requiredRecord(value, field);
  assertOnlyKeys(record, ["env"], field);
  const name = requiredString(record.env, field);
  assertEnvironmentVariableName(name, field);
  return Object.freeze({ env: name });
}

function resolveReferenceableString(
  value: string | HostEnvironmentReference,
  environment: HostEnvironment,
): string {
  if (typeof value === "string") return value;
  const resolved = environment[value.env];
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw configurationError("runtime_provider_configuration_environment_missing", value.env);
  }
  return resolved;
}

function resolveReferenceRecord(
  references: Readonly<Record<string, HostEnvironmentReference>> | undefined,
  environment: HostEnvironment,
): Record<string, string> {
  const resolved = createStringRecord();
  for (const [key, reference] of Object.entries(references ?? {})) {
    resolved[key] = resolveReferenceableString(reference, environment);
  }
  return resolved;
}

function assertHttpBaseUrl(value: string): void {
  try {
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password) {
      throw configurationError("runtime_provider_configuration_base_url_invalid", "transport.baseUrl");
    }
  } catch (error) {
    if (error instanceof RuntimeProviderConfigurationError) throw error;
    throw configurationError("runtime_provider_configuration_base_url_invalid", "transport.baseUrl");
  }
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError("runtime_provider_configuration_invalid", field);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw configurationError("runtime_provider_configuration_invalid", field);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) {
    throw configurationError("runtime_provider_configuration_unknown_field", field);
  }
}

function assertEnvironmentVariableName(value: string, field: string): void {
  if (!ENVIRONMENT_VARIABLE_NAME.test(value)) {
    throw configurationError("runtime_provider_configuration_environment_name_invalid", field);
  }
}

function assertHttpHeaderName(value: string, field: string): void {
  if (!HTTP_HEADER_NAME.test(value)) {
    throw configurationError("runtime_provider_configuration_header_name_invalid", field);
  }
}

function createStringRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function configurationError(code: string, field?: string): RuntimeProviderConfigurationError {
  return new RuntimeProviderConfigurationError(code, field);
}
