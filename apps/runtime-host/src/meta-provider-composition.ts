import { isAbsolute } from "node:path";
import type { MetaAgentPort, ProtocolPin } from "@agent-workspace/provider-port";
import {
  CODEX_META_APP_SERVER_PROTOCOL_0_146,
  CODEX_META_BINARY_SHA256_0_146,
  createCodexMetaAgentPort,
  type CodexMetaAppServerConnectionFactory,
} from "@agent-workspace/provider-codex";
import {
  createCodexMetaAppServerConnectionFactory,
  type CodexMetaAppServerBridgeOptions,
} from "./codex-meta-app-server-bridge.js";

export const RUNTIME_META_PROVIDER_CONFIGURATION_ENV = "AGENT_WORKSPACE_META_PROVIDER_CONFIG";

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const META_CHILD_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
]);

export type MetaProviderHostEnvironment = Readonly<Record<string, string | undefined>>;
export type MetaProviderEnvironmentReference = Readonly<{ readonly env: string }>;

export type CodexMetaTransportConfiguration = Readonly<{
  readonly kind: "codex-meta-app-server";
  readonly command: string | MetaProviderEnvironmentReference;
  /** Values remain Host-only and are resolved from explicitly named variables. */
  readonly env: Readonly<Record<string, MetaProviderEnvironmentReference>>;
}>;

export type RuntimeMetaProviderConfiguration = Readonly<{
  readonly schemaVersion: 1;
  readonly provider: Readonly<{
    readonly provider: "codex";
    readonly protocol: ProtocolPin;
    readonly binarySha256: string;
    readonly transport: CodexMetaTransportConfiguration;
  }>;
}>;

export type RuntimeMetaProviderCompositionOptions = Readonly<{
  readonly environment?: MetaProviderHostEnvironment;
  readonly runtimeDataDirectory?: string;
  /** Focused test seam. Production always uses the concrete Host bridge. */
  readonly connectionFactoryBuilder?: (
    options: CodexMetaAppServerBridgeOptions,
  ) => CodexMetaAppServerConnectionFactory;
}>;

export type RuntimeMetaProviderEnvironmentLoaderOptions = RuntimeMetaProviderCompositionOptions & Readonly<{
  readonly configurationEnvironmentVariable?: string;
}>;

/** Safe configuration error: only a code and field/env identifier are retained. */
export class RuntimeMetaProviderConfigurationError extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, field?: string) {
    super(field ? `${code}: ${field}` : code);
    this.name = "RuntimeMetaProviderConfigurationError";
    this.code = code;
    this.field = field;
  }
}

export function parseRuntimeMetaProviderConfiguration(serialized: string): RuntimeMetaProviderConfiguration {
  if (typeof serialized !== "string" || !serialized.trim()) {
    throw configurationError("runtime_meta_provider_configuration_missing");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw configurationError("runtime_meta_provider_configuration_invalid_json");
  }
  return normalizeConfiguration(value);
}

/**
 * Composes the sole proven Meta Provider lane. Pin mismatch is rejected before
 * constructing a factory, and real hash/schema/no-tool proof remains deferred
 * to the adapter's typed readiness report. No fixture or Task Provider fallback
 * is ever installed.
 */
export function createRuntimeMetaAgentPorts(
  configuration: RuntimeMetaProviderConfiguration,
  options: RuntimeMetaProviderCompositionOptions = {},
): readonly MetaAgentPort[] {
  const normalized = normalizeConfiguration(configuration);
  assertExactPins(normalized);
  const runtimeDataDirectory = options.runtimeDataDirectory;
  if (typeof runtimeDataDirectory !== "string" || !isAbsolute(runtimeDataDirectory)) {
    throw configurationError("runtime_meta_provider_runtime_data_directory_required", "runtimeDataDirectory");
  }
  const environment = options.environment ?? process.env;
  const command = resolveReferenceableString(normalized.provider.transport.command, environment);
  if (!isAbsolute(command)) {
    throw configurationError("runtime_meta_provider_command_must_be_absolute", "provider.transport.command");
  }
  const childEnvironment = resolveEnvironment(normalized.provider.transport.env, environment);
  if (!childEnvironment.OPENAI_API_KEY) {
    // v1 never copies user ~/.codex auth. A named API key is the only production
    // auth boundary currently composed for the fresh per-process CODEX_HOME.
    throw configurationError("runtime_meta_provider_api_key_required", "provider.transport.env.OPENAI_API_KEY");
  }

  const builder = options.connectionFactoryBuilder ?? createCodexMetaAppServerConnectionFactory;
  let connectionFactory: CodexMetaAppServerConnectionFactory;
  try {
    connectionFactory = builder({
      command,
      runtimeDataDirectory,
      environment: childEnvironment,
    });
  } catch {
    throw configurationError("runtime_meta_provider_connection_factory_invalid", "provider.transport");
  }
  return Object.freeze([createCodexMetaAgentPort({ connectionFactory })]);
}

/** Missing/blank means unavailable by omission; malformed/mismatched is typed and fail-closed. */
export function loadRuntimeMetaAgentPortsFromEnvironment(
  options: RuntimeMetaProviderEnvironmentLoaderOptions = {},
): readonly MetaAgentPort[] {
  const environment = options.environment ?? process.env;
  const variable = options.configurationEnvironmentVariable ?? RUNTIME_META_PROVIDER_CONFIGURATION_ENV;
  assertEnvironmentVariableName(variable, "configurationEnvironmentVariable");
  const serialized = environment[variable];
  if (serialized === undefined || !serialized.trim()) return Object.freeze([]);
  return createRuntimeMetaAgentPorts(parseRuntimeMetaProviderConfiguration(serialized), options);
}

function normalizeConfiguration(value: unknown): RuntimeMetaProviderConfiguration {
  const root = requiredRecord(value, "configuration");
  assertOnlyKeys(root, ["provider", "schemaVersion"], "configuration");
  if (root.schemaVersion !== 1) {
    throw configurationError("runtime_meta_provider_configuration_schema_unsupported", "schemaVersion");
  }
  const provider = requiredRecord(root.provider, "provider");
  assertOnlyKeys(provider, ["binarySha256", "protocol", "provider", "transport"], "provider");
  if (provider.provider !== "codex") {
    throw configurationError("runtime_meta_provider_unsupported", "provider.provider");
  }
  const protocolRecord = requiredRecord(provider.protocol, "provider.protocol");
  assertOnlyKeys(protocolRecord, ["protocolFingerprint", "providerVersion"], "provider.protocol");
  const protocol = Object.freeze({
    providerVersion: requiredString(protocolRecord.providerVersion, "provider.protocol.providerVersion"),
    protocolFingerprint: requiredString(protocolRecord.protocolFingerprint, "provider.protocol.protocolFingerprint"),
  });
  const transportRecord = requiredRecord(provider.transport, "provider.transport");
  assertOnlyKeys(transportRecord, ["command", "env", "kind"], "provider.transport");
  if (transportRecord.kind !== "codex-meta-app-server") {
    throw configurationError("runtime_meta_provider_transport_unsupported", "provider.transport.kind");
  }
  const environmentReferences = parseEnvironmentReferences(transportRecord.env, "provider.transport.env");
  return Object.freeze({
    schemaVersion: 1,
    provider: Object.freeze({
      provider: "codex",
      protocol,
      binarySha256: requiredString(provider.binarySha256, "provider.binarySha256"),
      transport: Object.freeze({
        kind: "codex-meta-app-server",
        command: parseReferenceableString(transportRecord.command, "provider.transport.command"),
        env: environmentReferences,
      }),
    }),
  });
}

function assertExactPins(configuration: RuntimeMetaProviderConfiguration): void {
  if (configuration.provider.binarySha256 !== CODEX_META_BINARY_SHA256_0_146) {
    throw configurationError("runtime_meta_provider_binary_pin_mismatch", "provider.binarySha256");
  }
  const protocol = configuration.provider.protocol;
  if (protocol.providerVersion !== CODEX_META_APP_SERVER_PROTOCOL_0_146.providerVersion
    || protocol.protocolFingerprint !== CODEX_META_APP_SERVER_PROTOCOL_0_146.protocolFingerprint) {
    throw configurationError("runtime_meta_provider_protocol_pin_mismatch", "provider.protocol");
  }
}

function parseEnvironmentReferences(
  value: unknown,
  field: string,
): Readonly<Record<string, MetaProviderEnvironmentReference>> {
  const record = requiredRecord(value, field);
  const references: Record<string, MetaProviderEnvironmentReference> = Object.create(null) as Record<string, MetaProviderEnvironmentReference>;
  for (const [key, candidate] of Object.entries(record)) {
    if (!META_CHILD_ENVIRONMENT_KEYS.has(key)) {
      throw configurationError("runtime_meta_provider_environment_key_forbidden", `${field}.${key}`);
    }
    references[key] = parseEnvironmentReference(candidate, `${field}.${key}`);
  }
  return Object.freeze(references);
}

function parseReferenceableString(value: unknown, field: string): string | MetaProviderEnvironmentReference {
  return typeof value === "string" ? requiredString(value, field) : parseEnvironmentReference(value, field);
}

function parseEnvironmentReference(value: unknown, field: string): MetaProviderEnvironmentReference {
  const record = requiredRecord(value, field);
  assertOnlyKeys(record, ["env"], field);
  const variable = requiredString(record.env, field);
  assertEnvironmentVariableName(variable, field);
  return Object.freeze({ env: variable });
}

function resolveReferenceableString(
  value: string | MetaProviderEnvironmentReference,
  environment: MetaProviderHostEnvironment,
): string {
  if (typeof value === "string") return value;
  return resolveEnvironmentReference(value, environment);
}

function resolveEnvironment(
  references: Readonly<Record<string, MetaProviderEnvironmentReference>>,
  environment: MetaProviderHostEnvironment,
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, reference] of Object.entries(references)) {
    resolved[key] = resolveEnvironmentReference(reference, environment);
  }
  return Object.freeze(resolved);
}

function resolveEnvironmentReference(
  reference: MetaProviderEnvironmentReference,
  environment: MetaProviderHostEnvironment,
): string {
  const value = environment[reference.env];
  if (typeof value !== "string" || !value.trim()) {
    throw configurationError("runtime_meta_provider_environment_missing", reference.env);
  }
  return value;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError("runtime_meta_provider_configuration_invalid", field);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw configurationError("runtime_meta_provider_configuration_invalid", field);
  }
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const keys = new Set(allowed);
  if (Object.keys(record).some((key) => !keys.has(key))) {
    throw configurationError("runtime_meta_provider_configuration_unknown_field", field);
  }
}

function assertEnvironmentVariableName(value: string, field: string): void {
  if (!ENVIRONMENT_VARIABLE_NAME.test(value)) {
    throw configurationError("runtime_meta_provider_environment_name_invalid", field);
  }
}

function configurationError(code: string, field?: string): RuntimeMetaProviderConfigurationError {
  return new RuntimeMetaProviderConfigurationError(code, field);
}
