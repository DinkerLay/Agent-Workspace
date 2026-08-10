import type {
  MetaProfileDefinition,
  MetaProfileOptionDefinition,
  MetaProfileOptionReadModel,
} from "@agent-workspace/runtime-contracts";

export interface MetaProfileRegistry {
  readonly resolveAvailable: (metaProfileOptionId: string) => MetaProfileOptionDefinition;
  readonly listDefinitions: () => readonly MetaProfileOptionDefinition[];
  readonly listReadinessOptions: () => readonly MetaProfileOptionReadModel[];
}

export function createMetaProfileRegistry(
  options: readonly MetaProfileOptionDefinition[],
): MetaProfileRegistry {
  const byOptionId = new Map<string, MetaProfileOptionDefinition>();
  for (const input of options) {
    const option = validateAndCloneOption(input);
    if (byOptionId.has(option.metaProfileOptionId)) throw new Error("meta_profile_option_duplicate");
    byOptionId.set(option.metaProfileOptionId, option);
  }
  return Object.freeze({
    resolveAvailable(metaProfileOptionId: string): MetaProfileOptionDefinition {
      const option = byOptionId.get(metaProfileOptionId);
      if (!option) throw new Error("meta_profile_option_not_found");
      if (option.availability !== "available") throw new Error(`meta_profile_option_unavailable:${option.unavailableReason ?? "unavailable"}`);
      return cloneOption(option);
    },
    listDefinitions(): readonly MetaProfileOptionDefinition[] {
      return [...byOptionId.values()].map(cloneOption);
    },
    listReadinessOptions(): readonly MetaProfileOptionReadModel[] {
      return [...byOptionId.values()].map((option) => ({
        metaProfileOptionId: option.metaProfileOptionId,
        title: option.title,
        availability: option.availability,
        ...(option.unavailableReason === undefined ? {} : { unavailableReason: option.unavailableReason }),
        profile: {
          provider: option.profile.provider,
          model: option.profile.model,
          providerVersion: option.profile.providerVersion,
          protocolFingerprint: option.profile.protocolFingerprint,
        },
      }));
    },
  });
}

function validateAndCloneOption(input: MetaProfileOptionDefinition): MetaProfileOptionDefinition {
  if (!input.metaProfileOptionId.startsWith("meta_profile_option_")) throw new Error("meta_profile_option_id_invalid");
  requiredText(input.title, "meta_profile_option_title_required", 160);
  if (input.availability !== "available" && input.availability !== "unavailable") {
    throw new Error("meta_profile_option_availability_invalid");
  }
  if (input.availability === "unavailable") {
    requiredText(input.unavailableReason ?? "", "meta_profile_option_unavailable_reason_required", 1_000);
  } else if (input.unavailableReason !== undefined) {
    throw new Error("meta_profile_option_available_reason_not_allowed");
  }
  validateMetaProfile(input.profile);
  return cloneOption(input);
}

function validateMetaProfile(profile: MetaProfileDefinition): void {
  if (!profile.metaProfileId.startsWith("meta_profile_")) throw new Error("meta_profile_id_invalid");
  requiredText(profile.model, "meta_profile_model_required", 500);
  requiredText(profile.providerVersion, "meta_profile_provider_version_required", 300);
  requiredText(profile.protocolFingerprint, "meta_profile_protocol_fingerprint_required", 300);
  if (profile.capabilityPolicy.allowedTools.length !== 0) throw new Error("meta_profile_tools_not_allowed");
  if (profile.capabilityPolicy.permissionMode !== "deny") throw new Error("meta_profile_permission_mode_invalid");
  if (profile.capabilityPolicy.maxNativeChildren !== 0) throw new Error("meta_profile_native_children_not_allowed");
  if (!Number.isSafeInteger(profile.capabilityPolicy.maxConcurrentTurns) || profile.capabilityPolicy.maxConcurrentTurns < 1) {
    throw new Error("meta_profile_concurrency_invalid");
  }
}

function cloneOption(option: MetaProfileOptionDefinition): MetaProfileOptionDefinition {
  return {
    metaProfileOptionId: option.metaProfileOptionId,
    title: option.title,
    availability: option.availability,
    ...(option.unavailableReason === undefined ? {} : { unavailableReason: option.unavailableReason }),
    profile: {
      ...option.profile,
      capabilityPolicy: {
        ...option.profile.capabilityPolicy,
        requiredCapabilities: [...option.profile.capabilityPolicy.requiredCapabilities],
        allowedTools: [],
      },
    },
  };
}

function requiredText(value: string, code: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(code);
  return value.trim();
}
