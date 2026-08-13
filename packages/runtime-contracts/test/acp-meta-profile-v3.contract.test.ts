import { describe, expect, it } from "vitest";
import {
  validateMetaProfileDefinitionV3,
  validateMetaProfileOptionDefinitionV3,
  type AcpProfileReadinessObservation,
  type MetaProfileDefinitionV3,
} from "../src";

describe("ACP Meta Profile v3 contract", () => {
  it("accepts only a portable, no-authority Meta Profile", () => {
    const profile = metaProfile();

    expect(validateMetaProfileDefinitionV3(profile)).toEqual(profile);
    expect(JSON.stringify(profile)).not.toMatch(
      /providerVersion|protocolFingerprint|launcher|artifactDigest|credential|cwd|rawSessionId/,
    );

    for (const [field, value] of [
      ["providerVersion", "0.147.0"],
      ["protocolFingerprint", "sha256:private"],
      ["launcherPath", "/opt/homebrew/bin/opencode"],
      ["artifactDigest", "sha256:private"],
      ["resolutionId", "resolution_private"],
      ["rawSessionId", "raw-session"],
      ["cwd", "/private/workspace"],
    ] as const) {
      expect(() => validateMetaProfileDefinitionV3({ ...profile, [field]: value }), field)
        .toThrow(/not supported|Host-private|portable/i);
    }

    expect(() => validateMetaProfileDefinitionV3({
      ...profile,
      configIntent: { behavior: { launcher: "/private/agent", rawRequestId: "raw-request" } },
    })).toThrow(/Host-private/i);
  });

  it("enforces protocol v1, role=meta and the exact no-tool process policy", () => {
    const profile = metaProfile();
    expect(validateMetaProfileDefinitionV3({
      ...profile,
      capabilityPolicy: { ...profile.capabilityPolicy, requiredCapabilities: [] },
    }).capabilityPolicy.requiredCapabilities).toEqual([]);
    const cases: readonly [string, unknown][] = [
      ["protocol", { ...profile, protocolMajor: 2 }],
      ["role", { ...profile, role: "worker" }],
      ["tools", {
        ...profile,
        capabilityPolicy: { ...profile.capabilityPolicy, allowedTools: ["invoke_agent"] },
      }],
      ["permission", {
        ...profile,
        capabilityPolicy: { ...profile.capabilityPolicy, permissionMode: "ask" },
      }],
      ["concurrency", {
        ...profile,
        capabilityPolicy: { ...profile.capabilityPolicy, maxConcurrentTurns: 2 },
      }],
      ["native children", {
        ...profile,
        capabilityPolicy: { ...profile.capabilityPolicy, maxNativeChildren: 1 },
      }],
      ["native child capability", {
        ...profile,
        capabilityPolicy: { ...profile.capabilityPolicy, requiredCapabilities: ["native_child"] },
      }],
      ["attention capability", {
        ...profile,
        capabilityPolicy: { ...profile.capabilityPolicy, requiredCapabilities: ["attention_reply"] },
      }],
    ];

    for (const [name, candidate] of cases) {
      expect(() => validateMetaProfileDefinitionV3(candidate), name).toThrow();
    }
  });

  it("binds an exact Host option to the same safe readiness identity", () => {
    const profile = metaProfile();
    const readiness = metaReadiness();
    const option = {
      metaProfileOptionId: "meta_profile_option_acp-contract",
      title: "Current Codex ACP Meta",
      profile,
      readiness,
    } as const;

    expect(validateMetaProfileOptionDefinitionV3(option)).toEqual(option);
    expect(() => validateMetaProfileOptionDefinitionV3({
      ...option,
      availability: "available",
    })).toThrow(/not supported/i);
    expect(() => validateMetaProfileOptionDefinitionV3({
      ...option,
      readiness: { ...readiness, model: "other-model" },
    })).toThrow(/readiness.*model|profile.*readiness/i);
    expect(() => validateMetaProfileOptionDefinitionV3({
      ...option,
      readiness: { ...readiness, role: "worker" },
    })).toThrow(/readiness.*role|profile.*readiness/i);
  });
});

function metaProfile(): MetaProfileDefinitionV3 {
  return {
    metaProfileId: "meta_profile_acp-contract",
    profileRevisionId: "profile_revision_meta-acp-contract",
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    role: "meta",
    model: "openai/gpt-5.6-sol",
    configIntent: { reasoningEffort: "high" },
    requiredExtensions: ["agent-workspace.dev/structured-final"],
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        "interrupt",
      ],
      allowedTools: [],
      permissionMode: "deny",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function metaReadiness(): AcpProfileReadinessObservation {
  return {
    profileRevisionId: "profile_revision_meta-acp-contract",
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    role: "meta",
    status: "available",
    reasons: [],
    missingCapabilities: [],
    missingExtensions: [],
    model: "openai/gpt-5.6-sol",
    observedProtocolMajor: 1,
    observedAgent: { name: "codex-acp", title: "Codex ACP", version: "1.1.14" },
    observedArtifactVersion: "1.1.14",
    observedUpstreamVersion: "0.147.0",
    observedCapabilities: ["session_new", "session_prompt", "session_cancel"],
    observedExtensions: ["agent-workspace.dev/structured-final"],
  };
}
