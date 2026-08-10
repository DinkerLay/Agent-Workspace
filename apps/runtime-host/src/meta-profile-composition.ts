import {
  createId,
  hashDefinition,
  type MetaProfileOptionDefinition,
  type ProviderKind,
} from "@agent-workspace/runtime-contracts";

export const RUNTIME_META_PROFILE_CONFIGURATION_ENV = "AGENT_WORKSPACE_META_PROFILE_CONFIG";

type HostEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Host-owned configuration only. Tool, permission, cwd and child-agent policy
 * are deliberately not configurable in v1 and are frozen to the Meta safety
 * contract here.
 */
export function loadMetaProfileOptionsFromEnvironment(input: Readonly<{
  environment?: HostEnvironment;
  configurationEnvironmentVariable?: string;
}> = {}): readonly MetaProfileOptionDefinition[] {
  const environment = input.environment ?? process.env;
  const variable = input.configurationEnvironmentVariable ?? RUNTIME_META_PROFILE_CONFIGURATION_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error("meta_profile_configuration_environment_variable_invalid");
  const serialized = environment[variable];
  if (serialized === undefined || !serialized.trim()) return Object.freeze([]);
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("meta_profile_configuration_invalid_json");
  }
  return parseMetaProfileConfiguration(value);
}

export function parseMetaProfileConfiguration(value: unknown): readonly MetaProfileOptionDefinition[] {
  const root = exactRecord(value, ["schemaVersion", "options"], "meta_profile_configuration_invalid");
  if (root.schemaVersion !== 1 || !Array.isArray(root.options)) throw new Error("meta_profile_configuration_invalid");
  const seen = new Set<string>();
  const options = root.options.map((entry, index): MetaProfileOptionDefinition => {
    const option = exactRecord(entry, [
      "metaProfileOptionId", "title", "availability", "unavailableReason",
      "provider", "model", "providerVersion", "protocolFingerprint",
    ], `meta_profile_configuration_option_invalid:${index}`);
    const metaProfileOptionId = requiredText(option.metaProfileOptionId, 300, "meta_profile_option_id_invalid");
    if (!metaProfileOptionId.startsWith("meta_profile_option_") || seen.has(metaProfileOptionId)) {
      throw new Error("meta_profile_option_id_invalid");
    }
    seen.add(metaProfileOptionId);
    const availability = option.availability;
    if (availability !== "available" && availability !== "unavailable") throw new Error("meta_profile_option_availability_invalid");
    const unavailableReason = option.unavailableReason === undefined
      ? undefined
      : requiredText(option.unavailableReason, 1_000, "meta_profile_option_unavailable_reason_invalid");
    if (availability === "unavailable" && unavailableReason === undefined) throw new Error("meta_profile_option_unavailable_reason_required");
    if (availability === "available" && unavailableReason !== undefined) throw new Error("meta_profile_option_available_reason_not_allowed");
    const provider = requiredText(option.provider, 100, "meta_profile_provider_invalid") as ProviderKind;
    if (provider !== "codex" && provider !== "opencode" && provider !== "claude-code") throw new Error("meta_profile_provider_invalid");
    const identity = hashDefinition({ metaProfileOptionId, provider });
    return Object.freeze({
      metaProfileOptionId,
      title: requiredText(option.title, 160, "meta_profile_option_title_invalid"),
      availability,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      profile: Object.freeze({
        metaProfileId: createId("meta_profile", identity),
        provider,
        model: requiredText(option.model, 500, "meta_profile_model_invalid"),
        providerVersion: requiredText(option.providerVersion, 300, "meta_profile_provider_version_invalid"),
        protocolFingerprint: requiredText(option.protocolFingerprint, 300, "meta_profile_protocol_fingerprint_invalid"),
        capabilityPolicy: Object.freeze({
          requiredCapabilities: Object.freeze([]),
          allowedTools: Object.freeze([]),
          permissionMode: "deny" as const,
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        }),
      }),
    });
  });
  return Object.freeze(options);
}

function exactRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error(code);
  return record;
}

function requiredText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(code);
  return value.trim();
}
