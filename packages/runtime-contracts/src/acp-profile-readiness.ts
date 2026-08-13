import type { ExecutionProfileRevisionId } from "./ids";
import type { ACPAgentKind, AgentCardKind, ProviderFamily } from "./templates";

export type AcpProfileRole = AgentCardKind | "worker" | "meta";
export type AcpProfileReadinessStatus =
  | "checking"
  | "available"
  | "unavailable"
  | "capability_missing";

export interface AcpObservedAgentIdentity {
  readonly name: string;
  readonly title?: string;
  readonly version?: string;
}

/** Safe ACP-declared model choice; it is not a qualification grant. */
export interface AcpProfileModelCatalogEntry {
  readonly modelId: string;
  readonly label: string;
}

/**
 * Shared Renderer-safe Task/Meta readiness. It is an observation only: local
 * paths, resolution/seal identity, digests, fingerprints and raw ACP IDs are
 * deliberately absent and rejected by the validator below.
 */
export interface AcpProfileReadinessObservation {
  readonly profileRevisionId: ExecutionProfileRevisionId;
  readonly providerFamily: ProviderFamily;
  readonly acpAgentKind: ACPAgentKind;
  readonly role: AcpProfileRole;
  readonly status: AcpProfileReadinessStatus;
  readonly reasons: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly missingExtensions: readonly string[];
  readonly model: string;
  readonly modelCatalog?: readonly AcpProfileModelCatalogEntry[];
  readonly observedProtocolMajor?: number;
  readonly observedAgent?: AcpObservedAgentIdentity;
  readonly observedArtifactVersion?: string;
  readonly observedUpstreamVersion?: string;
  readonly observedCapabilities?: readonly string[];
  readonly observedExtensions?: readonly string[];
}

export class AcpProfileReadinessValidationError extends Error {
  readonly code = "acp_profile_readiness_invalid";

  constructor(message: string) {
    super(message);
    this.name = "AcpProfileReadinessValidationError";
  }
}

const READINESS_KEYS = [
  "profileRevisionId",
  "providerFamily",
  "acpAgentKind",
  "role",
  "status",
  "reasons",
  "missingCapabilities",
  "missingExtensions",
  "model",
  "modelCatalog",
  "observedProtocolMajor",
  "observedAgent",
  "observedArtifactVersion",
  "observedUpstreamVersion",
  "observedCapabilities",
  "observedExtensions",
] as const;
const OPTIONAL_READINESS_KEYS = new Set([
  "modelCatalog",
  "observedProtocolMajor",
  "observedAgent",
  "observedArtifactVersion",
  "observedUpstreamVersion",
  "observedCapabilities",
  "observedExtensions",
]);
const AGENT_KEYS = ["name", "title", "version"] as const;
const OPTIONAL_AGENT_KEYS = new Set(["title", "version"]);
const MODEL_CATALOG_KEYS = ["modelId", "label"] as const;
const PROVIDER_FAMILIES = new Set<ProviderFamily>(["opencode", "codex", "claude-code"]);
const ACP_AGENT_KINDS = new Set<ACPAgentKind>(["native_acp", "codex_acp", "claude_agent_acp"]);
const ROLES = new Set<AcpProfileRole>([
  "conductor",
  "general",
  "researcher",
  "implementer",
  "reviewer",
  "publisher",
  "worker",
  "meta",
]);
const STATUSES = new Set<AcpProfileReadinessStatus>([
  "checking",
  "available",
  "unavailable",
  "capability_missing",
]);
const SAFE_CAPABILITY = /^[a-z][a-z0-9_.-]{0,127}$/u;
const SAFE_EXTENSION = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/u;
const SAFE_REASON = /^[a-z0-9][a-z0-9:_.-]{0,191}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+:@-]{0,159}$/u;
const PORTABLE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+\[\]-]*)?$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_LIST_ENTRIES = 128;

export function validateAcpProfileReadinessObservation(
  value: unknown,
): AcpProfileReadinessObservation {
  const root = exactRecord(
    value,
    READINESS_KEYS,
    OPTIONAL_READINESS_KEYS,
    "ACP Profile readiness shape is invalid",
  );
  const profileRevisionId = prefixedId(
    root.profileRevisionId,
    "profile_revision_",
    "ACP Profile readiness profileRevisionId is invalid",
  );
  const providerFamily = enumValue(
    root.providerFamily,
    PROVIDER_FAMILIES,
    "ACP Profile readiness providerFamily is invalid",
  );
  const acpAgentKind = enumValue(
    root.acpAgentKind,
    ACP_AGENT_KINDS,
    "ACP Profile readiness acpAgentKind is invalid",
  );
  assertProviderAgentKind(providerFamily, acpAgentKind);
  const role = enumValue(root.role, ROLES, "ACP Profile readiness role is invalid");
  const status = enumValue(root.status, STATUSES, "ACP Profile readiness status is invalid");
  const reasons = stringList(root.reasons, safeReason, "ACP Profile readiness reasons are invalid");
  const missingCapabilities = stringList(
    root.missingCapabilities,
    safeCapability,
    "ACP Profile readiness missing capabilities are invalid",
  );
  const missingExtensions = stringList(
    root.missingExtensions,
    safeExtension,
    "ACP Profile readiness missing extensions are invalid",
  );
  const model = safeModel(root.model);
  const modelCatalog = root.modelCatalog === undefined
    ? undefined
    : safeModelCatalog(root.modelCatalog);

  if (status === "available" && (reasons.length > 0 || missingCapabilities.length > 0 || missingExtensions.length > 0)) {
    invalid("ACP Profile readiness available state cannot contain reasons or missing requirements");
  }
  if (status === "checking" && (missingCapabilities.length > 0 || missingExtensions.length > 0)) {
    invalid("ACP Profile readiness checking state cannot claim missing requirements");
  }
  if (status === "unavailable" && reasons.length === 0) {
    invalid("ACP Profile readiness unavailable state requires a safe reason");
  }
  if (status === "capability_missing"
    && (reasons.length === 0 || (missingCapabilities.length === 0 && missingExtensions.length === 0))) {
    invalid("ACP Profile readiness capability_missing state requires a reason and a missing requirement");
  }

  const observedProtocolMajor = root.observedProtocolMajor === undefined
    ? undefined
    : nonNegativeInteger(root.observedProtocolMajor, "ACP Profile readiness observed protocol major is invalid");
  const observedAgent = root.observedAgent === undefined
    ? undefined
    : safeAgent(root.observedAgent);
  const observedArtifactVersion = root.observedArtifactVersion === undefined
    ? undefined
    : safeVersion(root.observedArtifactVersion, "ACP Profile readiness artifact version is invalid");
  const observedUpstreamVersion = root.observedUpstreamVersion === undefined
    ? undefined
    : safeVersion(root.observedUpstreamVersion, "ACP Profile readiness upstream version is invalid");
  const observedCapabilities = root.observedCapabilities === undefined
    ? undefined
    : stringList(
        root.observedCapabilities,
        safeCapability,
        "ACP Profile readiness observed capabilities are invalid",
      );
  const observedExtensions = root.observedExtensions === undefined
    ? undefined
    : stringList(
        root.observedExtensions,
        safeExtension,
        "ACP Profile readiness observed extensions are invalid",
      );

  return Object.freeze({
    profileRevisionId,
    providerFamily,
    acpAgentKind,
    role,
    status,
    reasons,
    missingCapabilities,
    missingExtensions,
    model,
    ...(modelCatalog === undefined ? {} : { modelCatalog }),
    ...(observedProtocolMajor === undefined ? {} : { observedProtocolMajor }),
    ...(observedAgent === undefined ? {} : { observedAgent }),
    ...(observedArtifactVersion === undefined ? {} : { observedArtifactVersion }),
    ...(observedUpstreamVersion === undefined ? {} : { observedUpstreamVersion }),
    ...(observedCapabilities === undefined ? {} : { observedCapabilities }),
    ...(observedExtensions === undefined ? {} : { observedExtensions }),
  });
}

function safeModelCatalog(value: unknown): readonly AcpProfileModelCatalogEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ENTRIES) {
    invalid("ACP Profile readiness model catalog is invalid");
  }
  const result = value.map((entry) => {
    const root = exactRecord(
      entry,
      MODEL_CATALOG_KEYS,
      new Set(),
      "ACP Profile readiness model catalog entry is invalid",
    );
    return Object.freeze({
      modelId: safeModel(root.modelId),
      label: safeDisplayText(root.label, "ACP Profile readiness model label is invalid"),
    });
  });
  if (new Set(result.map(({ modelId }) => modelId)).size !== result.length) {
    invalid("ACP Profile readiness model catalog contains duplicate model IDs");
  }
  return Object.freeze(result);
}

function safeAgent(value: unknown): AcpObservedAgentIdentity {
  const root = exactRecord(
    value,
    AGENT_KEYS,
    OPTIONAL_AGENT_KEYS,
    "ACP Profile readiness observed agent shape is invalid",
  );
  return Object.freeze({
    name: portableAgentName(root.name),
    ...(root.title === undefined
      ? {}
      : { title: safeDisplayText(root.title, "ACP Profile readiness observed agent title is invalid") }),
    ...(root.version === undefined
      ? {}
      : { version: safeVersion(root.version, "ACP Profile readiness observed agent version is invalid") }),
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  optional: ReadonlySet<string>,
  message: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(message);
  const root = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(root)) if (!allowed.has(key)) invalid(`${message}: unsupported field ${key}`);
  for (const key of keys) {
    if (!optional.has(key) && !(key in root)) invalid(`${message}: required field ${key}`);
  }
  return root;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, message: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) invalid(message);
  return value as T;
}

function prefixedId(value: unknown, prefix: string, message: string): string {
  if (typeof value !== "string"
    || !new RegExp(`^${prefix}[A-Za-z0-9-]+$`, "u").test(value)) invalid(message);
  return value as string;
}

function stringList(
  value: unknown,
  validate: (entry: unknown) => string,
  message: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) invalid(message);
  const result = Array.from(value as unknown[], validate);
  if (new Set(result).size !== result.length) invalid(`${message}: duplicate entry`);
  return Object.freeze(result);
}

function safeCapability(value: unknown): string {
  if (typeof value !== "string" || !SAFE_CAPABILITY.test(value)) {
    invalid("ACP Profile readiness capability name is invalid");
  }
  return value as string;
}

function safeExtension(value: unknown): string {
  if (typeof value !== "string"
    || !SAFE_EXTENSION.test(value)
    || value.startsWith("/")
    || value.includes("//")
    || value.split("/").includes("..")) {
    invalid("ACP Profile readiness extension name is invalid");
  }
  return value as string;
}

function safeReason(value: unknown): string {
  if (typeof value !== "string") invalid("ACP Profile readiness reason is invalid");
  const extensionPrefix = "acp_extension_missing:";
  if ((value as string).startsWith(extensionPrefix)) {
    safeExtension((value as string).slice(extensionPrefix.length));
    return value as string;
  }
  if (!SAFE_REASON.test(value as string)) invalid("ACP Profile readiness reason is invalid");
  return value as string;
}

function safeModel(value: unknown): string {
  if (typeof value !== "string"
    || CONTROL_CHARACTER.test(value)
    || !PORTABLE_MODEL.test(value)
    || value.startsWith("/")
    || value.includes("\\")) {
    invalid("ACP Profile readiness model is not a safe portable identifier");
  }
  return value as string;
}

function portableAgentName(value: unknown): string {
  if (typeof value !== "string"
    || value.length > 160
    || CONTROL_CHARACTER.test(value)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/u.test(value)) {
    invalid("ACP Profile readiness observed agent name is invalid");
  }
  return value as string;
}

function safeDisplayText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || CONTROL_CHARACTER.test(value)) invalid(message);
  const text = value.trim();
  if (text.startsWith("/")
    || text.startsWith("file://")
    || text.startsWith("~/")
    || text.includes("\\")
    || /(?:^|[\s(])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/u.test(text)) invalid(message);
  return text;
}

function safeVersion(value: unknown, message: string): string {
  if (typeof value !== "string" || !SAFE_VERSION.test(value)) invalid(message);
  return value as string;
}

function nonNegativeInteger(value: unknown, message: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(message);
  return value as number;
}

function assertProviderAgentKind(providerFamily: ProviderFamily, acpAgentKind: ACPAgentKind): void {
  const expected: Readonly<Record<ProviderFamily, ACPAgentKind>> = {
    opencode: "native_acp",
    codex: "codex_acp",
    "claude-code": "claude_agent_acp",
  };
  if (expected[providerFamily] !== acpAgentKind) {
    invalid("ACP Profile readiness providerFamily and acpAgentKind do not match");
  }
}

function invalid(message: string): never {
  throw new AcpProfileReadinessValidationError(message);
}
