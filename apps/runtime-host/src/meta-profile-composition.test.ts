import { describe, expect, it } from "vitest";
import { loadMetaProfileOptionsFromEnvironment, parseMetaProfileConfiguration } from "./meta-profile-composition.js";

describe("Host Meta profile composition", () => {
  it("builds only the fixed no-tool Meta policy from Host configuration", () => {
    const [option] = parseMetaProfileConfiguration({
      schemaVersion: 1,
      options: [{
        metaProfileOptionId: "meta_profile_option_codex_0146",
        title: "Codex Meta",
        availability: "available",
        provider: "codex",
        model: "gpt-5.6",
        providerVersion: "0.146.0",
        protocolFingerprint: "sha256:28161abf",
      }],
    });
    expect(option).toMatchObject({
      metaProfileOptionId: "meta_profile_option_codex_0146",
      profile: {
        provider: "codex",
        model: "gpt-5.6",
        capabilityPolicy: {
          requiredCapabilities: [],
          allowedTools: [],
          permissionMode: "deny",
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        },
      },
    });
    expect(JSON.stringify(option)).not.toMatch(/cwd|workspace|credential|apiKey|tools":\[[^\]]/i);
  });

  it("fails closed on unknown policy fields and represents an explicit unavailable pin", () => {
    expect(() => parseMetaProfileConfiguration({
      schemaVersion: 1,
      options: [{
        metaProfileOptionId: "meta_profile_option_spoofed",
        title: "Unsafe",
        availability: "available",
        provider: "codex",
        model: "gpt-5.6",
        providerVersion: "0.146.0",
        protocolFingerprint: "sha256:pin",
        allowedTools: ["shell"],
      }],
    })).toThrow("meta_profile_configuration_option_invalid");
    expect(loadMetaProfileOptionsFromEnvironment({
      environment: {
        META: JSON.stringify({
          schemaVersion: 1,
          options: [{
            metaProfileOptionId: "meta_profile_option_opencode_mismatch",
            title: "OpenCode Meta",
            availability: "unavailable",
            unavailableReason: "managed_pin_mismatch",
            provider: "opencode",
            model: "opencode/deepseek-v4-flash-free",
            providerVersion: "1.18.13",
            protocolFingerprint: "sha256:pinned",
          }],
        }),
      },
      configurationEnvironmentVariable: "META",
    })[0]).toMatchObject({ availability: "unavailable", unavailableReason: "managed_pin_mismatch" });
  });
});
