import { describe, expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import type { AcpQualificationObservation } from "@agent-workspace/provider-acp";
import {
  createAcpProfileResolutionRegistry,
  type AcpCurrentInstallDescriptor,
  type AcpDiscoveredArtifact,
} from "./acp-profile-resolution.js";
import {
  AcpQualificationError,
  createAcpQualificationAuthority,
  type AcpHostGenerationFence,
} from "./acp-qualification.js";

function profile(revision = "profile_revision_1", model = "model-current"): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "execution_profile_test" as ExecutionProfileDefinitionV3["executionProfileId"],
    profileRevisionId: revision,
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    model,
    configIntent: {},
    requiredExtensions: [],
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
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function artifact(label = "A"): AcpDiscoveredArtifact {
  return {
    canonicalLauncherPath: `/private/codex/${label}/codex-acp`,
    launchArguments: [],
    observedArtifactVersion: `wrapper-${label}`,
    observedUpstreamVersion: `codex-${label}`,
    artifactDigest: `sha256:${label.repeat(64)}`,
    trustState: "trusted",
    executionConfigDigest: `sha256:${label.toLowerCase().repeat(64)}`,
    environment: {},
  };
}

function initialized(): AcpQualificationObservation {
  return {
    available: true,
    protocolMajor: 1,
    agent: { name: "codex-acp" },
    capabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
    extensions: [],
    capabilityFingerprint: `sha256:${"a".repeat(64)}`,
    unavailableReasons: [],
  };
}

function generation(): AcpHostGenerationFence & { active: boolean } {
  return {
    active: true,
    isActive() {
      return this.active;
    },
  };
}

describe("process-local ACP qualification", () => {
  it("cannot be forged, serialized, or reused across profile, model, role policy, or generation", async () => {
    const descriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "codex-acp-current",
      discoverCurrent: async () => artifact(),
    };
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
    const currentGeneration = generation();
    const authority = createAcpQualificationAuthority();
    const result = await authority.issue({
      profile: profile(),
      resolution,
      generation: currentGeneration,
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
      initializeObservation: initialized(),
      probe: {
        role: "worker",
        requiredBehaviors: ["managed_session_core"],
        passedBehaviors: ["managed_session_core"],
        safeObservations: { promptTerminalCorrelated: true },
      },
    });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("expected qualification");

    await expect(authority.assertUsable(result.qualification, {
      profile: profile(),
      resolution,
      generation: currentGeneration,
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      initializeFingerprint: initialized().capabilityFingerprint,
    })).resolves.toBeUndefined();

    const serialized = JSON.parse(JSON.stringify(result.qualification));
    for (const [qualification, expected] of [
      [Object.freeze({}), {}],
      [serialized, {}],
      [result.qualification, { profile: profile("profile_revision_2") }],
      [result.qualification, { actualModel: "other-model" }],
      [result.qualification, { rolePolicyDigest: "sha256:conductor-policy" }],
      [result.qualification, { generation: generation() }],
      [result.qualification, { initializeFingerprint: `sha256:${"b".repeat(64)}` }],
    ] as const) {
      await expect(authority.assertUsable(qualification, {
        profile: profile(),
        resolution,
        generation: currentGeneration,
        actualModel: "model-current",
        rolePolicyDigest: "sha256:worker-policy",
        initializeFingerprint: initialized().capabilityFingerprint,
        ...expected,
      })).rejects.toBeInstanceOf(AcpQualificationError);
    }
  });

  it("fails closed on inactive generations and artifact drift, then permits a newly resolved generation", async () => {
    let current = artifact("A");
    const descriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "codex-acp-current",
      discoverCurrent: async () => current,
    };
    const registry = createAcpProfileResolutionRegistry();
    const resolutionA = await registry.resolve(profile(), descriptor);
    const generationA = generation();
    const authority = createAcpQualificationAuthority();
    const issuedA = await authority.issue({
      profile: profile(),
      resolution: resolutionA,
      generation: generationA,
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
      initializeObservation: initialized(),
      probe: {
        role: "worker",
        requiredBehaviors: [],
        passedBehaviors: [],
      },
    });
    if (!issuedA.available) throw new Error("expected qualification");

    generationA.active = false;
    await expect(authority.assertUsable(issuedA.qualification, {
      profile: profile(),
      resolution: resolutionA,
      generation: generationA,
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      initializeFingerprint: initialized().capabilityFingerprint,
    })).rejects.toMatchObject({ code: "acp_qualification_generation_inactive" });

    generationA.active = true;
    current = artifact("B");
    await expect(authority.assertUsable(issuedA.qualification, {
      profile: profile(),
      resolution: resolutionA,
      generation: generationA,
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      initializeFingerprint: initialized().capabilityFingerprint,
    })).rejects.toMatchObject({ code: "acp_current_artifact_drift" });

    const resolutionB = await registry.resolve(profile(), descriptor);
    const generationB = generation();
    const issuedB = await authority.issue({
      profile: profile(),
      resolution: resolutionB,
      generation: generationB,
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
      initializeObservation: initialized(),
      probe: { role: "worker", requiredBehaviors: [], passedBehaviors: [] },
    });
    expect(issuedB.available).toBe(true);
  });

  it("returns only safe reasons when initialize or a role probe is insufficient", async () => {
    const descriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "codex-acp-current",
      discoverCurrent: async () => artifact(),
    };
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
    const authority = createAcpQualificationAuthority();
    const result = await authority.issue({
      profile: profile(),
      resolution,
      generation: generation(),
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
      initializeObservation: {
        ...initialized(),
        available: false,
        unavailableReasons: ["acp_capability_missing:session_resume"],
      },
      probe: {
        role: "worker",
        requiredBehaviors: ["managed_session_core", "cancel_reconcile"],
        passedBehaviors: ["managed_session_core"],
      },
    });

    expect(result).toMatchObject({
      available: false,
      report: {
        unavailableReasons: [
          "acp_capability_missing:session_resume",
          "acp_behavior_missing:cancel_reconcile",
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("/private/codex");
  });

  it("does not mint from contradictory initialize flags, wrong major, or a missing required capability", async () => {
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "codex-acp-current",
      discoverCurrent: async () => artifact(),
    });
    const authority = createAcpQualificationAuthority();
    for (const initializeObservation of [
      { ...initialized(), available: false, unavailableReasons: [] },
      { ...initialized(), protocolMajor: 2, unavailableReasons: [] },
      {
        ...initialized(),
        capabilities: ["session_new", "session_prompt", "session_update"] as const,
        unavailableReasons: [],
      },
    ]) {
      const result = await authority.issue({
        profile: profile(),
        resolution,
        generation: generation(),
        actualModel: "model-current",
        rolePolicyDigest: "sha256:worker-policy",
        requiredAcpCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
        initializeObservation,
        probe: { role: "worker", requiredBehaviors: [], passedBehaviors: [] },
      });
      expect(result.available).toBe(false);
    }
  });

  it("requires every portable v3 extension by exact safe name", async () => {
    const extensionProfile = {
      ...profile(),
      requiredExtensions: ["vendor/session-tools"],
    };
    const resolution = await createAcpProfileResolutionRegistry().resolve(extensionProfile, {
      descriptorId: "codex-acp-current",
      discoverCurrent: async () => artifact(),
    });
    const authority = createAcpQualificationAuthority();
    const base = {
      profile: extensionProfile,
      resolution,
      generation: generation(),
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      requiredAcpCapabilities: ["session_new"] as const,
      probe: { role: "worker" as const, requiredBehaviors: [], passedBehaviors: [] },
    };
    await expect(authority.issue({
      ...base,
      initializeObservation: initialized(),
    })).resolves.toMatchObject({
      available: false,
      report: { unavailableReasons: ["acp_extension_missing:vendor/session-tools"] },
    });
    await expect(authority.issue({
      ...base,
      generation: generation(),
      initializeObservation: { ...initialized(), extensions: ["vendor/session-tools"] },
    })).resolves.toMatchObject({ available: true });
  });

  it("rejects embedded private paths and control text at SafeReport normalization", async () => {
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "codex-acp-safe-report",
      discoverCurrent: async () => artifact(),
    });
    const authority = createAcpQualificationAuthority();
    const unsafeAgents = [
      { name: "Agent at /private/user/token" },
      { name: "Agent", title: "C:\\Users\\alice\\secret" },
      { name: "Agent", title: "D:/Users/alice/secret" },
      { name: "Agent", title: "file:///Users/alice/secret" },
      { name: "Agent", title: "config at ~/.agent/auth.json" },
      { name: "Agent", title: "line one\n/private/line-two" },
      { name: "Agent", title: "share \\\\server\\private\\token" },
    ];
    for (const agent of unsafeAgents) {
      await expect(authority.issue({
        profile: profile(),
        resolution,
        generation: generation(),
        actualModel: "model-current",
        rolePolicyDigest: "sha256:worker-policy",
        requiredAcpCapabilities: ["session_new"],
        initializeObservation: { ...initialized(), agent },
        probe: { role: "worker", requiredBehaviors: [], passedBehaviors: [] },
      })).rejects.toMatchObject({ code: "acp_initialize_agent_invalid" });
    }
  });

  it("rejects unknown exact-key fields in nested qualification inputs", async () => {
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "codex-acp-exact-keys",
      discoverCurrent: async () => artifact(),
    });
    const authority = createAcpQualificationAuthority();
    const base = {
      profile: profile(),
      resolution,
      generation: generation(),
      actualModel: "model-current",
      rolePolicyDigest: "sha256:worker-policy",
      requiredAcpCapabilities: ["session_new"] as const,
      probe: { role: "worker" as const, requiredBehaviors: [], passedBehaviors: [] },
    };
    const extraInitialize = {
      ...initialized(),
      rawAgentPath: "/private/agent",
    };
    await expect(authority.issue({
      ...base,
      initializeObservation: extraInitialize,
    })).rejects.toMatchObject({ code: "acp_initialize_observation_invalid" });

    const extraAgent = {
      name: "safe-agent",
      rawLauncherPath: "/private/agent",
    };
    await expect(authority.issue({
      ...base,
      generation: generation(),
      initializeObservation: { ...initialized(), agent: extraAgent },
    })).rejects.toMatchObject({ code: "acp_initialize_agent_invalid" });

    const extraProbe = {
      role: "worker" as const,
      requiredBehaviors: [],
      passedBehaviors: [],
      rawSessionId: "raw-session-private",
    };
    await expect(authority.issue({
      ...base,
      generation: generation(),
      initializeObservation: initialized(),
      probe: extraProbe,
    })).rejects.toMatchObject({ code: "acp_behavior_probe_invalid" });
  });
});
