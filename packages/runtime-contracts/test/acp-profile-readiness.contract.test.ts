import { describe, expect, it } from "vitest";
import {
  validateAcpProfileReadinessObservation,
  type AcpProfileReadinessObservation,
} from "../src";

describe("safe ACP Profile readiness contract", () => {
  it("projects the same exact safe observation for Task and Meta roles", () => {
    const source = readiness();
    const validated = validateAcpProfileReadinessObservation(source);

    expect(validated).toEqual(source);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.observedCapabilities)).toBe(true);
    expect(Object.isFrozen(validated.modelCatalog)).toBe(true);
    expect(JSON.stringify(validated)).not.toMatch(
      /path|hash|fingerprint|resolution|rawSession|nativeSession|requestId|cwd/i,
    );
    expect(validateAcpProfileReadinessObservation({
      ...source,
      profileRevisionId: "profile_revision_task-worker",
      role: "implementer",
      status: "capability_missing",
      reasons: ["acp_capability_missing:mcp_http"],
      missingCapabilities: ["mcp_http"],
    }).role).toBe("implementer");
  });

  it("rejects every local resolution, raw identity and fingerprint escape hatch", () => {
    const source = readiness();
    for (const [field, value] of [
      ["canonicalLauncherPath", "/opt/homebrew/bin/codex"],
      ["launcherPath", "/private/agent"],
      ["artifactDigest", "sha256:private"],
      ["capabilityFingerprint", "sha256:private"],
      ["probeFingerprint", "sha256:private"],
      ["resolutionId", "resolution_private"],
      ["rawSessionId", "raw-session"],
      ["nativeSessionId", "native-session"],
      ["cwd", "/private/workspace"],
    ] as const) {
      expect(() => validateAcpProfileReadinessObservation({ ...source, [field]: value }), field)
        .toThrow(/shape|field|supported|safe/i);
    }
    expect(() => validateAcpProfileReadinessObservation({
      ...source,
      observedAgent: { ...source.observedAgent, rawRequestId: "raw-request" },
    })).toThrow(/agent.*shape|field|supported/i);
  });

  it("rejects unsafe diagnostics and internally contradictory states", () => {
    const source = readiness();
    expect(() => validateAcpProfileReadinessObservation({
      ...source,
      reasons: ["probe failed at /Users/private/workspace"],
    })).toThrow(/reason/i);
    expect(() => validateAcpProfileReadinessObservation({
      ...source,
      observedArtifactVersion: "/private/codex-acp",
    })).toThrow(/version/i);
    expect(() => validateAcpProfileReadinessObservation({
      ...source,
      status: "available",
      missingExtensions: ["agent-workspace.dev/missing"],
    })).toThrow(/available.*missing|state/i);
    expect(() => validateAcpProfileReadinessObservation({
      ...source,
      status: "capability_missing",
      reasons: [],
      missingCapabilities: [],
      missingExtensions: [],
    })).toThrow(/capability_missing|state/i);
    expect(() => validateAcpProfileReadinessObservation({
      ...source,
      modelCatalog: [{ modelId: "opencode/current-model", label: "Current" }, {
        modelId: "opencode/current-model",
        label: "Duplicate",
      }],
    })).toThrow(/duplicate/i);
    expect(() => validateAcpProfileReadinessObservation({
      ...source,
      modelCatalog: [{ modelId: "opencode/other", label: "/Users/private/model" }],
    })).toThrow(/label/i);
  });
});

function readiness(): AcpProfileReadinessObservation {
  return {
    profileRevisionId: "profile_revision_meta-readiness",
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
    role: "meta",
    status: "available",
    reasons: [],
    missingCapabilities: [],
    missingExtensions: [],
    model: "opencode/current-model",
    modelCatalog: [
      { modelId: "opencode/current-model", label: "Current model" },
      { modelId: "opencode/next-model", label: "Next model" },
    ],
    observedProtocolMajor: 1,
    observedAgent: { name: "opencode", title: "OpenCode", version: "1.0.200" },
    observedArtifactVersion: "1.0.200",
    observedCapabilities: ["session_new", "session_prompt", "session_cancel", "session_update"],
    observedExtensions: [],
  };
}
