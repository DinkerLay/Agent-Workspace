import {
  CODEX_META_APP_SERVER_PROTOCOL_0_146,
  CODEX_META_BINARY_SHA256_0_146,
  CODEX_META_NO_TOOL_ATTESTATION_0_146,
  type CodexMetaAppServerConnectionFactory,
} from "@agent-workspace/provider-codex";
import { describe, expect, it } from "vitest";
import type { CodexMetaAppServerBridgeOptions } from "./codex-meta-app-server-bridge.js";
import {
  RuntimeMetaProviderConfigurationError,
  createRuntimeMetaAgentPorts,
  loadRuntimeMetaAgentPortsFromEnvironment,
  parseRuntimeMetaProviderConfiguration,
} from "./meta-provider-composition.js";

describe("Runtime Host Meta Provider composition", () => {
  it("returns no port when Host configuration is absent and never creates a fallback", () => {
    let constructed = 0;
    expect(loadRuntimeMetaAgentPortsFromEnvironment({
      environment: {},
      runtimeDataDirectory: "/private/runtime-data",
      connectionFactoryBuilder: () => {
        constructed += 1;
        return provenFactory();
      },
    })).toEqual([]);
    expect(constructed).toBe(0);
  });

  it("resolves only named Host secrets and composes a typed ready Codex Meta port", async () => {
    const inputs: CodexMetaAppServerBridgeOptions[] = [];
    const [port] = loadRuntimeMetaAgentPortsFromEnvironment({
      environment: {
        META_CONFIG: JSON.stringify(configuration()),
        CODEX_META_BINARY: "/private/verified/codex-0.146.0",
        CODEX_META_API_KEY: "host-secret-key",
        UNREFERENCED_SECRET: "must-not-leak",
      },
      configurationEnvironmentVariable: "META_CONFIG",
      runtimeDataDirectory: "/private/runtime-data",
      connectionFactoryBuilder: (options) => {
        inputs.push(options);
        return provenFactory();
      },
    });

    expect(inputs).toEqual([{
      command: "/private/verified/codex-0.146.0",
      runtimeDataDirectory: "/private/runtime-data",
      environment: { OPENAI_API_KEY: "host-secret-key" },
    }]);
    await expect(port!.describeMetaCapabilities(profile())).resolves.toEqual({
      provider: "codex",
      available: true,
      providerVersion: CODEX_META_APP_SERVER_PROTOCOL_0_146.providerVersion,
      protocolFingerprint: CODEX_META_APP_SERVER_PROTOCOL_0_146.protocolFingerprint,
      unavailableReasons: [],
    });
  });

  it("rejects declared binary/protocol mismatch before constructing or inspecting a factory", () => {
    let effects = 0;
    const options = {
      environment: {
        CODEX_META_BINARY: "/private/verified/codex-0.146.0",
        CODEX_META_API_KEY: "host-secret-key",
      },
      runtimeDataDirectory: "/private/runtime-data",
      connectionFactoryBuilder: () => {
        effects += 1;
        return provenFactory();
      },
    } as const;
    expect(() => createRuntimeMetaAgentPorts(parseRuntimeMetaProviderConfiguration(JSON.stringify(configuration({
      binarySha256: "0".repeat(64),
    }))), options)).toThrow(expect.objectContaining({
      code: "runtime_meta_provider_binary_pin_mismatch",
    }));
    expect(() => createRuntimeMetaAgentPorts(parseRuntimeMetaProviderConfiguration(JSON.stringify(configuration({
      protocol: { ...CODEX_META_APP_SERVER_PROTOCOL_0_146, providerVersion: "0.145.0" },
    }))), options)).toThrow(expect.objectContaining({
      code: "runtime_meta_provider_protocol_pin_mismatch",
    }));
    expect(effects).toBe(0);
  });

  it("surfaces missing auth as a safe typed configuration error and an unproven process as typed unavailable", async () => {
    const withoutAuth = configuration({ transportEnv: {} });
    expect(() => createRuntimeMetaAgentPorts(parseRuntimeMetaProviderConfiguration(JSON.stringify(withoutAuth)), {
      environment: { CODEX_META_BINARY: "/private/verified/codex-0.146.0" },
      runtimeDataDirectory: "/private/runtime-data",
    })).toThrow(expect.objectContaining({
      code: "runtime_meta_provider_api_key_required",
      field: "provider.transport.env.OPENAI_API_KEY",
    }));

    const [port] = createRuntimeMetaAgentPorts(parseRuntimeMetaProviderConfiguration(JSON.stringify(configuration())), {
      environment: {
        CODEX_META_BINARY: "/private/verified/codex-0.146.0",
        CODEX_META_API_KEY: "host-secret-key",
      },
      runtimeDataDirectory: "/private/runtime-data",
      connectionFactoryBuilder: () => ({
        inspectProtocol: async () => CODEX_META_APP_SERVER_PROTOCOL_0_146,
        inspectNoToolConfiguration: async () => {
          throw new Error("token=host-secret-key account=secret@example.test");
        },
        create: async () => {
          throw new Error("must_not_create");
        },
      }),
    });
    const report = await port!.describeMetaCapabilities(profile());
    expect(report).toMatchObject({
      provider: "codex",
      available: false,
      unavailableReasons: ["codex_meta_no_tool_configuration_unavailable"],
    });
    expect(JSON.stringify(report)).not.toMatch(/host-secret|account|example|token/i);
  });

  it("strictly rejects unknown fields, forbidden child env, and missing secret references", () => {
    expect(() => parseRuntimeMetaProviderConfiguration(JSON.stringify({
      ...configuration(),
      fixtureFallback: true,
    }))).toThrow(expect.objectContaining({
      code: "runtime_meta_provider_configuration_unknown_field",
    }));
    expect(() => parseRuntimeMetaProviderConfiguration(JSON.stringify(configuration({
      transportEnv: { HOME: { env: "USER_HOME" } },
    })))).toThrow(expect.objectContaining({
      code: "runtime_meta_provider_environment_key_forbidden",
    }));
    let observed: unknown;
    try {
      createRuntimeMetaAgentPorts(parseRuntimeMetaProviderConfiguration(JSON.stringify(configuration())), {
        environment: {
          CODEX_META_BINARY: "/private/verified/codex-0.146.0",
          CODEX_META_API_KEY: "",
        },
        runtimeDataDirectory: "/private/runtime-data",
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(RuntimeMetaProviderConfigurationError);
    expect((observed as RuntimeMetaProviderConfigurationError).code).toBe("runtime_meta_provider_environment_missing");
    expect((observed as Error).message).toBe("runtime_meta_provider_environment_missing: CODEX_META_API_KEY");
    expect((observed as Error).message).not.toMatch(/verified|secret/i);
  });
});

function configuration(overrides: Readonly<{
  readonly binarySha256?: string;
  readonly protocol?: Readonly<{ readonly providerVersion: string; readonly protocolFingerprint: string }>;
  readonly transportEnv?: Readonly<Record<string, Readonly<{ readonly env: string }>>>;
}> = {}) {
  return {
    schemaVersion: 1,
    provider: {
      provider: "codex",
      protocol: overrides.protocol ?? CODEX_META_APP_SERVER_PROTOCOL_0_146,
      binarySha256: overrides.binarySha256 ?? CODEX_META_BINARY_SHA256_0_146,
      transport: {
        kind: "codex-meta-app-server",
        command: { env: "CODEX_META_BINARY" },
        env: overrides.transportEnv ?? { OPENAI_API_KEY: { env: "CODEX_META_API_KEY" } },
      },
    },
  };
}

function profile() {
  return {
    metaProfileId: "meta_profile_composition_test",
    provider: "codex" as const,
    model: "gpt-5.6",
    providerVersion: CODEX_META_APP_SERVER_PROTOCOL_0_146.providerVersion,
    protocolFingerprint: CODEX_META_APP_SERVER_PROTOCOL_0_146.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities: [],
      allowedTools: [],
      permissionMode: "deny" as const,
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function provenFactory(): CodexMetaAppServerConnectionFactory {
  return {
    inspectProtocol: async () => CODEX_META_APP_SERVER_PROTOCOL_0_146,
    inspectNoToolConfiguration: async () => CODEX_META_NO_TOOL_ATTESTATION_0_146,
    create: async () => {
      throw new Error("not_used");
    },
  };
}
