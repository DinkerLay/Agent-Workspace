import { createHash } from "node:crypto";
import { failAcp } from "./errors.js";
import type {
  AcpExtensionPredicate,
  AcpQualificationObservation,
  AcpV1Capability,
  AcpV1QualificationRequirements,
} from "./types.js";

const MAX_CAPABILITY_SNAPSHOT_BYTES = 64 * 1024;
const MAX_CAPABILITY_SNAPSHOT_DEPTH = 32;
const MAX_CAPABILITY_SNAPSHOT_NODES = 4_096;
const MAX_EXTENSION_PREDICATES = 64;
const CUSTOM_EXTENSION_NAME = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})+$/u;
const STANDARD_EXTENSION_NAMES = new Set([
  "auth/logout",
  "mcp/acp",
  "mcp/http",
  "mcp/sse",
  "nes",
  "prompt/audio",
  "prompt/embedded-context",
  "prompt/image",
  "providers",
  "position-encoding/utf-16",
  "position-encoding/utf-32",
  "position-encoding/utf-8",
  "session/additional-directories",
  "session/close",
  "session/delete",
  "session/fork",
  "session/list",
  "session/load",
  "session/resume",
]);

const BASELINE_CAPABILITIES: readonly AcpV1Capability[] = [
  "session_new",
  "session_prompt",
  "session_cancel",
  "session_update",
  "mcp_stdio",
  "permission",
];
const ACP_V1_CAPABILITY_NAMES = new Set<AcpV1Capability>([
  ...BASELINE_CAPABILITIES,
  "session_load",
  "session_resume",
  "session_close",
  "mcp_http",
  "mcp_sse",
]);

export function qualifyInitializeResponse(
  response: unknown,
  requirements: AcpV1QualificationRequirements,
  extensionPredicates: Readonly<Record<string, AcpExtensionPredicate>> = {},
): AcpQualificationObservation {
  const record = asRecord(response, "acp_initialize_response_invalid");
  const protocolMajor = typeof record.protocolVersion === "number"
    && Number.isInteger(record.protocolVersion)
    ? record.protocolVersion
    : null;
  const agentCapabilities = record.agentCapabilities === undefined
    ? {}
    : asRecord(record.agentCapabilities, "acp_agent_capabilities_invalid");
  const extensionMeta = record._meta === undefined || record._meta === null
    ? null
    : asRecord(record._meta, "acp_initialize_extension_meta_invalid");
  const initializeSnapshot = canonicalCapabilitySnapshot({
    protocolMajor,
    agentCapabilities,
    extensionMeta,
  });
  const extensionProofInput = freezeJsonTree({
    protocolVersion: protocolMajor,
    agentCapabilities: structuredClone(agentCapabilities),
    _meta: extensionMeta === null ? null : structuredClone(extensionMeta),
  });
  const sessionCapabilities = optionalRecord(agentCapabilities?.sessionCapabilities);
  const mcpCapabilities = optionalRecord(agentCapabilities?.mcpCapabilities);
  const capabilities = new Set<AcpV1Capability>(BASELINE_CAPABILITIES);
  if (agentCapabilities?.loadSession === true) capabilities.add("session_load");
  if (sessionCapabilities?.resume != null) capabilities.add("session_resume");
  if (sessionCapabilities?.close != null) capabilities.add("session_close");
  if (mcpCapabilities?.http === true) capabilities.add("mcp_http");
  if (mcpCapabilities?.sse === true) capabilities.add("mcp_sse");
  const sortedCapabilities = [...capabilities].sort();
  const extensions = projectExtensionNames(
    extensionProofInput,
    agentCapabilities,
    extensionPredicates,
  );
  const requiredExtensions = normalizeRequiredExtensionNames(
    requirements.requiredExtensions,
  );
  const requiredCapabilities = normalizeRequiredCapabilityNames(
    requirements.requiredCapabilities,
  );
  const unavailableReasons: string[] = [];
  if (protocolMajor !== requirements.protocolMajor) {
    unavailableReasons.push("acp_protocol_major_mismatch");
  } else {
    for (const capability of requiredCapabilities) {
      if (!capabilities.has(capability)) {
        unavailableReasons.push(`acp_capability_missing:${capability}`);
      }
    }
    for (const extension of requiredExtensions) {
      if (!extensions.includes(extension)) {
        unavailableReasons.push(`acp_extension_missing:${extension}`);
      }
    }
  }
  const agentInfo = record.agentInfo === undefined || record.agentInfo === null
    ? undefined
    : asRecord(record.agentInfo, "acp_agent_info_invalid");
  const name = optionalSafeDisplayText(
    agentInfo?.name,
    160,
    "acp_agent_info_name_invalid",
  );
  const title = optionalSafeDisplayText(
    agentInfo?.title,
    240,
    "acp_agent_info_title_invalid",
  );
  const version = optionalSafeVersion(agentInfo?.version);
  return Object.freeze({
    available: unavailableReasons.length === 0,
    protocolMajor,
    ...(name ? {
      agent: Object.freeze({
        name,
        ...(title ? { title } : {}),
        ...(version ? { version } : {}),
      }),
    } : {}),
    capabilities: Object.freeze(sortedCapabilities),
    extensions,
    capabilityFingerprint: `sha256:${createHash("sha256")
      .update(initializeSnapshot)
      .digest("hex")}`,
    unavailableReasons: Object.freeze(unavailableReasons),
  });
}

export function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) failAcp(code);
  return value as Record<string, unknown>;
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function normalizeRequiredExtensionNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_EXTENSION_PREDICATES) {
    failAcp("acp_extension_requirements_invalid");
  }
  const names = value.map((entry) => {
    if (typeof entry !== "string" || !isExtensionName(entry)) {
      failAcp("acp_extension_requirement_name_invalid");
    }
    return entry;
  });
  if (new Set(names).size !== names.length) {
    failAcp("acp_extension_requirement_duplicate");
  }
  return Object.freeze([...names].sort());
}

export function normalizeRequiredCapabilityNames(
  value: unknown,
): readonly AcpV1Capability[] {
  if (!Array.isArray(value) || value.length > ACP_V1_CAPABILITY_NAMES.size) {
    failAcp("acp_capability_requirements_invalid");
  }
  const names = value.map((entry) => {
    if (typeof entry !== "string" || !ACP_V1_CAPABILITY_NAMES.has(entry as AcpV1Capability)) {
      failAcp("acp_capability_requirement_name_invalid");
    }
    return entry as AcpV1Capability;
  });
  if (new Set(names).size !== names.length) {
    failAcp("acp_capability_requirement_duplicate");
  }
  return Object.freeze([...names].sort());
}

/** Unknown wire fields are fingerprinted but only these exact Host proofs grant names. */
export function normalizeExtensionPredicates(
  value: CreateExtensionPredicateInput,
): Readonly<Record<string, AcpExtensionPredicate>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failAcp("acp_extension_predicates_invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_EXTENSION_PREDICATES) {
    failAcp("acp_extension_predicates_too_many");
  }
  const normalized: Record<string, AcpExtensionPredicate> = {};
  for (const [name, predicate] of entries) {
    if (
      !isCustomExtensionName(name)
      || STANDARD_EXTENSION_NAMES.has(name)
      || typeof predicate !== "function"
    ) {
      failAcp("acp_extension_predicate_invalid");
    }
    normalized[name] = predicate;
  }
  return Object.freeze(normalized);
}

type CreateExtensionPredicateInput =
  | Readonly<Record<string, AcpExtensionPredicate>>
  | undefined;

function optionalSafeDisplayText(
  value: unknown,
  maxLength: number,
  code: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\p{Cc}\p{Cf}]/u.test(value)
    || isPathLike(value)
  ) failAcp(code);
  return value;
}

function optionalSafeVersion(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/u.test(value)
  ) failAcp("acp_agent_info_version_invalid");
  return value;
}

function isPathLike(value: string): boolean {
  return value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith("~/")
    || /^[A-Za-z]:[\\/]/u.test(value);
}

function projectExtensionNames(
  initializeResponse: unknown,
  agentCapabilities: Record<string, unknown>,
  extensionPredicates: Readonly<Record<string, AcpExtensionPredicate>>,
): readonly string[] {
  const names = new Set<string>();
  const prompt = optionalCapabilityRecord(
    agentCapabilities.promptCapabilities,
    "acp_prompt_capabilities_invalid",
  );
  const mcp = optionalCapabilityRecord(
    agentCapabilities.mcpCapabilities,
    "acp_mcp_capabilities_invalid",
  );
  const session = optionalCapabilityRecord(
    agentCapabilities.sessionCapabilities,
    "acp_session_capabilities_invalid",
  );
  const auth = optionalCapabilityRecord(
    agentCapabilities.auth,
    "acp_auth_capabilities_invalid",
  );

  if (agentCapabilities.loadSession === true) names.add("session/load");
  if (
    agentCapabilities.loadSession !== undefined
    && typeof agentCapabilities.loadSession !== "boolean"
  ) failAcp("acp_load_session_capability_invalid");
  addBooleanExtension(prompt, "image", "prompt/image", names);
  addBooleanExtension(prompt, "audio", "prompt/audio", names);
  addBooleanExtension(prompt, "embeddedContext", "prompt/embedded-context", names);
  addBooleanExtension(mcp, "http", "mcp/http", names);
  addBooleanExtension(mcp, "sse", "mcp/sse", names);
  addBooleanExtension(mcp, "acp", "mcp/acp", names);
  addObjectExtension(session, "list", "session/list", names);
  addObjectExtension(session, "delete", "session/delete", names);
  addObjectExtension(
    session,
    "additionalDirectories",
    "session/additional-directories",
    names,
  );
  addObjectExtension(session, "fork", "session/fork", names);
  addObjectExtension(session, "resume", "session/resume", names);
  addObjectExtension(session, "close", "session/close", names);
  addObjectExtension(auth, "logout", "auth/logout", names);
  addTopLevelObjectExtension(agentCapabilities, "providers", "providers", names);
  addTopLevelObjectExtension(agentCapabilities, "nes", "nes", names);
  const positionEncoding = agentCapabilities.positionEncoding;
  if (positionEncoding !== undefined && positionEncoding !== null) {
    if (!["utf-16", "utf-32", "utf-8"].includes(positionEncoding as string)) {
      failAcp("acp_position_encoding_capability_invalid");
    }
    names.add(`position-encoding/${positionEncoding as string}`);
  }
  for (const [name, predicate] of Object.entries(extensionPredicates)) {
    let matched: unknown;
    try {
      matched = predicate(initializeResponse);
    } catch {
      failAcp("acp_extension_predicate_failed");
    }
    if (typeof matched !== "boolean") failAcp("acp_extension_predicate_result_invalid");
    if (matched) names.add(name);
  }
  return Object.freeze([...names].sort());
}

function optionalCapabilityRecord(
  value: unknown,
  code: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return asRecord(value, code);
}

function addBooleanExtension(
  record: Record<string, unknown> | undefined,
  key: string,
  name: string,
  output: Set<string>,
): void {
  const value = record?.[key];
  if (value === true) output.add(name);
  if (value !== undefined && typeof value !== "boolean") {
    failAcp("acp_boolean_extension_capability_invalid");
  }
}

function addObjectExtension(
  record: Record<string, unknown> | undefined,
  key: string,
  name: string,
  output: Set<string>,
): void {
  if (!record || record[key] === undefined || record[key] === null) return;
  asRecord(record[key], "acp_object_extension_capability_invalid");
  output.add(name);
}

function addTopLevelObjectExtension(
  record: Record<string, unknown>,
  key: string,
  name: string,
  output: Set<string>,
): void {
  if (record[key] === undefined || record[key] === null) return;
  asRecord(record[key], "acp_object_extension_capability_invalid");
  output.add(name);
}

function isExtensionName(value: string): boolean {
  return value.length <= 128
    && (STANDARD_EXTENSION_NAMES.has(value) || isCustomExtensionName(value));
}

function isCustomExtensionName(value: string): boolean {
  return value.length <= 128 && CUSTOM_EXTENSION_NAME.test(value);
}

function canonicalCapabilitySnapshot(value: unknown): string {
  const budget = { bytes: 0, nodes: 0 };
  const active = new WeakSet<object>();

  function consume(text: string): string {
    budget.bytes += Buffer.byteLength(text, "utf8");
    if (budget.bytes > MAX_CAPABILITY_SNAPSHOT_BYTES) {
      failAcp("acp_agent_capabilities_snapshot_too_large");
    }
    return text;
  }

  function visit(entry: unknown, depth: number): string {
    budget.nodes += 1;
    if (
      budget.nodes > MAX_CAPABILITY_SNAPSHOT_NODES
      || depth > MAX_CAPABILITY_SNAPSHOT_DEPTH
    ) {
      failAcp("acp_agent_capabilities_snapshot_too_complex");
    }
    if (entry === null) return consume("null");
    if (typeof entry === "string" || typeof entry === "boolean") {
      return consume(JSON.stringify(entry));
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) failAcp("acp_agent_capabilities_snapshot_invalid");
      return consume(JSON.stringify(entry));
    }
    if (!entry || typeof entry !== "object") {
      failAcp("acp_agent_capabilities_snapshot_invalid");
    }
    if (active.has(entry)) failAcp("acp_agent_capabilities_snapshot_invalid");
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        consume("[");
        const parts = entry.map((item, index) => {
          if (index > 0) consume(",");
          return visit(item, depth + 1);
        });
        consume("]");
        return `[${parts.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        failAcp("acp_agent_capabilities_snapshot_invalid");
      }
      consume("{");
      const parts = Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item], index) => {
          if (index > 0) consume(",");
          const safeKey = consume(JSON.stringify(key));
          consume(":");
          return `${safeKey}:${visit(item, depth + 1)}`;
        });
      consume("}");
      return `{${parts.join(",")}}`;
    } finally {
      active.delete(entry);
    }
  }

  return visit(value, 0);
}

function freezeJsonTree<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezeJsonTree(entry);
  }
  return Object.freeze(value);
}
