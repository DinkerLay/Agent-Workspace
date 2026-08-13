import { describe, expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import {
  AcpProfileResolutionError,
  createAcpProfileResolutionRegistry,
  type AcpCurrentInstallDescriptor,
  type AcpDiscoveredArtifact,
} from "./acp-profile-resolution.js";

function profile(overrides: Partial<ExecutionProfileDefinitionV3> = {}): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "execution_profile_test" as ExecutionProfileDefinitionV3["executionProfileId"],
    profileRevisionId: "profile_revision_test_1",
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
    protocolMajor: 1,
    model: "current-model",
    configIntent: { reasoning: "balanced" },
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
    ...overrides,
  };
}

function artifact(label: string): AcpDiscoveredArtifact {
  return {
    canonicalLauncherPath: `/private/current/${label}/agent`,
    launchArguments: ["acp"],
    observedArtifactVersion: label === "A" ? "999.0.0-unknown" : "1000.0.0-next",
    observedUpstreamVersion: `upstream-${label}`,
    artifactDigest: `sha256:${label.repeat(64)}`,
    trustState: "trusted",
    executionConfigDigest: `sha256:${label.toLowerCase().repeat(64)}`,
    environment: { LANG: "C.UTF-8" },
  };
}

describe("ACP current-install profile resolution", () => {
  it("invalidates A after current artifact drift and admits re-discovered B without a version allowlist", async () => {
    let current = artifact("A");
    const descriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "test-native-acp",
      discoverCurrent: async () => current,
    };
    const registry = createAcpProfileResolutionRegistry({
      now: () => "2026-08-11T00:00:00.000Z",
      createOpaqueId: () => "host_resolution_private_1",
    });

    const resolutionA = await registry.resolve(profile(), descriptor);
    await expect(resolutionA.assertCurrent()).resolves.toBeUndefined();
    expect(resolutionA.hostPrivateLaunchMaterial().observedArtifactVersion).toBe("999.0.0-unknown");

    current = artifact("B");
    await expect(resolutionA.assertCurrent()).rejects.toMatchObject({
      code: "acp_current_artifact_drift",
    });

    const resolutionB = await registry.resolve(profile(), descriptor);
    await expect(resolutionB.assertCurrent()).resolves.toBeUndefined();
    expect(resolutionB.hostPrivateLaunchMaterial().observedArtifactVersion).toBe("1000.0.0-next");
    expect(resolutionB).not.toBe(resolutionA);
  });

  it("shows sanitized observed versions as evidence while hiding paths, hashes, environment, and private ids", async () => {
    const current = artifact("A");
    const registry = createAcpProfileResolutionRegistry({
      now: () => "2026-08-11T00:00:00.000Z",
      createOpaqueId: () => "host_resolution_private_secret",
    });
    const resolution = await registry.resolve(profile(), {
      descriptorId: "test-native-acp",
      discoverCurrent: async () => current,
    });

    const serialized = JSON.stringify({
      resolution,
      observation: resolution.safeObservation(),
    });
    for (const secret of [
      current.canonicalLauncherPath,
      current.artifactDigest,
      current.executionConfigDigest,
      "host_resolution_private_secret",
      "C.UTF-8",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(resolution.safeObservation()).toEqual({
      profileRevisionId: "profile_revision_test_1",
      providerFamily: "opencode",
      acpAgentKind: "native_acp",
      protocolMajor: 1,
      trust: "trusted",
      observedArtifactVersion: "999.0.0-unknown",
      observedUpstreamVersion: "upstream-A",
    });
  });

  it("does not single-flight distinct descriptor objects that reuse the same descriptor id", async () => {
    const registry = createAcpProfileResolutionRegistry({
      now: () => "2026-08-11T00:00:00.000Z",
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondDiscoveries = 0;
    const firstDescriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "same-public-descriptor-id",
      discoverCurrent: async () => {
        await firstGate;
        return artifact("A");
      },
    };
    const secondDescriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "same-public-descriptor-id",
      discoverCurrent: async () => {
        secondDiscoveries += 1;
        return artifact("B");
      },
    };

    const firstPending = registry.resolve(profile(), firstDescriptor);
    const secondPending = registry.resolve(profile(), secondDescriptor);
    releaseFirst();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(first.safeObservation().observedArtifactVersion).toBe("999.0.0-unknown");
    expect(second.safeObservation().observedArtifactVersion).toBe("1000.0.0-next");
    expect(secondDiscoveries).toBe(1);
    expect(second).not.toBe(first);
  });

  it("rejects Host-only resolution fields embedded in a portable profile", async () => {
    const registry = createAcpProfileResolutionRegistry();
    const contaminated = {
      ...profile(),
      launcherPath: "/private/should-not-be-portable",
    } as ExecutionProfileDefinitionV3;

    await expect(registry.resolve(contaminated, {
      descriptorId: "test-native-acp",
      discoverCurrent: async () => artifact("A"),
    })).rejects.toBeInstanceOf(AcpProfileResolutionError);
    await expect(registry.resolve(contaminated, {
      descriptorId: "test-native-acp",
      discoverCurrent: async () => artifact("A"),
    })).rejects.toMatchObject({ code: "acp_portable_profile_contains_host_fields" });
  });
});
