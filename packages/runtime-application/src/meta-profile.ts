import type {
  MetaProfileOptionReadModel,
  MetaProfileOptionDefinitionV2,
  MetaProfileOptionDefinitionV3,
  MetaProfileOptionSnapshot,
} from "@agent-workspace/runtime-contracts";
import {
  validateMetaProfileDefinitionV2,
  validateMetaProfileOptionDefinitionV3,
} from "@agent-workspace/runtime-contracts";

export interface MetaProfileRegistry {
  /** New effects resolve only a portable v3 option; v2 is historical read data. */
  readonly resolveAvailable: (metaProfileOptionId: string) => MetaProfileOptionDefinitionV3;
  readonly listDefinitions: () => readonly MetaProfileOptionSnapshot[];
  readonly listReadinessOptions: () => readonly MetaProfileOptionReadModel[];
}

export function createMetaProfileRegistry(
  options: readonly MetaProfileOptionSnapshot[],
): MetaProfileRegistry {
  const byOptionId = new Map<string, MetaProfileOptionSnapshot>();
  for (const input of options) {
    const option = validateAndCloneOption(input);
    if (byOptionId.has(option.metaProfileOptionId)) throw new Error("meta_profile_option_duplicate");
    byOptionId.set(option.metaProfileOptionId, option);
  }
  return Object.freeze({
    resolveAvailable(metaProfileOptionId: string): MetaProfileOptionDefinitionV3 {
      const option = byOptionId.get(metaProfileOptionId);
      if (!option) throw new Error("meta_profile_option_not_found");
      if (!("readiness" in option)) throw new Error("meta_profile_v2_read_only");
      if (option.readiness.status !== "available") {
        throw new Error(`meta_profile_option_unavailable:${option.readiness.reasons[0] ?? option.readiness.status}`);
      }
      return cloneV3Option(option);
    },
    listDefinitions(): readonly MetaProfileOptionSnapshot[] {
      return [...byOptionId.values()].map(cloneOption);
    },
    listReadinessOptions(): readonly MetaProfileOptionReadModel[] {
      return [...byOptionId.values()].map(toReadModel);
    },
  });
}

function validateAndCloneOption(input: MetaProfileOptionSnapshot): MetaProfileOptionSnapshot {
  if ("readiness" in input) return validateMetaProfileOptionDefinitionV3(input);
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
  validateMetaProfileDefinitionV2(input.profile);
  return cloneV2Option(input);
}

function cloneOption(option: MetaProfileOptionSnapshot): MetaProfileOptionSnapshot {
  return "readiness" in option ? cloneV3Option(option) : cloneV2Option(option);
}

function cloneV2Option(option: MetaProfileOptionDefinitionV2): MetaProfileOptionDefinitionV2 {
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

function cloneV3Option(option: MetaProfileOptionDefinitionV3): MetaProfileOptionDefinitionV3 {
  return validateMetaProfileOptionDefinitionV3(option);
}

function toReadModel(option: MetaProfileOptionSnapshot): MetaProfileOptionReadModel {
  if (!("readiness" in option)) {
    return {
      metaProfileOptionId: option.metaProfileOptionId,
      title: option.title,
      availability: "unavailable",
      unavailableReason: "meta_profile_v2_read_only",
      profile: {
        provider: option.profile.provider,
        model: option.profile.model,
        providerVersion: option.profile.providerVersion,
        protocolFingerprint: option.profile.protocolFingerprint,
      },
    };
  }
  const readiness = option.readiness;
  return {
    metaProfileOptionId: option.metaProfileOptionId,
    title: option.title,
    availability: readiness.status === "available" ? "available" : "unavailable",
    ...(readiness.status === "available"
      ? {}
      : { unavailableReason: readiness.reasons[0] ?? readiness.status }),
    profile: {
      metaProfileId: option.profile.metaProfileId,
      profileRevisionId: option.profile.profileRevisionId,
      providerFamily: option.profile.providerFamily,
      acpAgentKind: option.profile.acpAgentKind,
      protocolMajor: option.profile.protocolMajor,
      role: option.profile.role,
      model: option.profile.model,
    },
    readiness,
  };
}

function requiredText(value: string, code: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(code);
  return value.trim();
}
