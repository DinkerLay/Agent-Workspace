import type {
  MetaProfileDefinitionV2,
  MetaProfileDefinitionV3,
  MetaProfileOptionDefinitionV2,
  MetaProfileOptionDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import { describe, expect, it } from "vitest";
import { createMetaProfileRegistry } from "./meta-profile.js";

describe("ACP Meta Profile option registry", () => {
  it("keeps same-brand options separate by opaque option and frozen revision", () => {
    const first = optionV3("alpha", "gpt-5.6-sol");
    const second = optionV3("beta", "gpt-5.6-terra");
    const registry = createMetaProfileRegistry([first, second]);

    expect(registry.resolveAvailable(first.metaProfileOptionId).profile).toEqual(first.profile);
    expect(registry.resolveAvailable(second.metaProfileOptionId).profile).toEqual(second.profile);
    expect(registry.listDefinitions()).toEqual([first, second]);
    expect(registry.listReadinessOptions()).toEqual([
      expect.objectContaining({
        metaProfileOptionId: first.metaProfileOptionId,
        availability: "available",
        profile: expect.objectContaining({ profileRevisionId: first.profile.profileRevisionId }),
        readiness: first.readiness,
      }),
      expect.objectContaining({
        metaProfileOptionId: second.metaProfileOptionId,
        availability: "available",
        profile: expect.objectContaining({ profileRevisionId: second.profile.profileRevisionId }),
        readiness: second.readiness,
      }),
    ]);
  });

  it("lists strict direct-v2 history but never resolves it for a new effect", () => {
    const legacy = optionV2();
    const registry = createMetaProfileRegistry([legacy]);

    expect(registry.listDefinitions()).toEqual([legacy]);
    expect(registry.listReadinessOptions()).toEqual([expect.objectContaining({
      metaProfileOptionId: legacy.metaProfileOptionId,
      availability: "unavailable",
      unavailableReason: "meta_profile_v2_read_only",
    })]);
    expect(() => registry.resolveAvailable(legacy.metaProfileOptionId)).toThrow("meta_profile_v2_read_only");
  });
});

function optionV3(suffix: string, model: string): MetaProfileOptionDefinitionV3 {
  const profile: MetaProfileDefinitionV3 = {
    metaProfileId: `meta_profile_${suffix}`,
    profileRevisionId: `profile_revision_meta-${suffix}`,
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    role: "meta",
    model,
    configIntent: { reasoningEffort: suffix === "alpha" ? "high" : "medium" },
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
  return {
    metaProfileOptionId: `meta_profile_option_${suffix}`,
    title: `Meta ${suffix}`,
    profile,
    readiness: {
      profileRevisionId: profile.profileRevisionId,
      providerFamily: profile.providerFamily,
      acpAgentKind: profile.acpAgentKind,
      role: profile.role,
      status: "available",
      reasons: [],
      missingCapabilities: [],
      missingExtensions: [],
      model: profile.model,
      observedProtocolMajor: 1,
      observedAgent: { name: "codex-acp", version: "current" },
      observedCapabilities: [],
      observedExtensions: [],
    },
  };
}

function optionV2(): MetaProfileOptionDefinitionV2 {
  const profile: MetaProfileDefinitionV2 = {
    metaProfileId: "meta_profile_legacy-registry",
    provider: "codex",
    model: "legacy-direct",
    providerVersion: "preserved",
    protocolFingerprint: "preserved",
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
  return {
    metaProfileOptionId: "meta_profile_option_legacy-registry",
    title: "Legacy Meta",
    availability: "available",
    profile,
  };
}
