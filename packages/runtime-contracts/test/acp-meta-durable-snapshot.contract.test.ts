import { describe, expect, it } from "vitest";
import {
  isMetaProfileDefinitionV3,
  validateMetaProfileSnapshot,
  type MetaProfileDefinitionV2,
  type MetaProfileDefinitionV3,
} from "../src/index.js";

describe("durable Meta profile snapshot schema dispatch", () => {
  it("reads strict v2/v3 snapshots without upgrading v2 bytes", () => {
    const legacy = profileV2();
    const portable = profileV3();
    expect(validateMetaProfileSnapshot(legacy)).toEqual(legacy);
    expect(validateMetaProfileSnapshot(portable)).toEqual(portable);
    expect(isMetaProfileDefinitionV3(legacy)).toBe(false);
    expect(isMetaProfileDefinitionV3(portable)).toBe(true);
    expect(JSON.stringify(validateMetaProfileSnapshot(legacy))).toBe(JSON.stringify(legacy));
  });

  it("rejects mixed, unknown, tool-enabled, and Host-local snapshots", () => {
    const legacy = profileV2();
    const portable = profileV3();
    expect(() => validateMetaProfileSnapshot({ ...legacy, profileRevisionId: portable.profileRevisionId }))
      .toThrow("meta_profile_snapshot_schema_ambiguous");
    expect(() => validateMetaProfileSnapshot({ ...portable, providerVersion: "must-not-enter-v3" }))
      .toThrow();
    expect(() => validateMetaProfileSnapshot({
      ...portable,
      capabilityPolicy: { ...portable.capabilityPolicy, allowedTools: ["shell"] },
    })).toThrow();
    expect(() => validateMetaProfileSnapshot({ ...portable, configIntent: { cwd: "/private/path" } }))
      .toThrow();
  });
});

function profileV2(): MetaProfileDefinitionV2 {
  return {
    metaProfileId: "meta_profile_legacy_snapshot",
    provider: "codex",
    model: "legacy",
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
}

function profileV3(): MetaProfileDefinitionV3 {
  return {
    metaProfileId: "meta_profile_portable-snapshot",
    profileRevisionId: "profile_revision_meta-portable-snapshot",
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    role: "meta",
    model: "gpt-5.6-terra",
    configIntent: { reasoningEffort: "medium" },
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}
