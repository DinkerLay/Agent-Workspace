import type { ExecutionProfileDefinition, ProviderKind } from "@agent-workspace/runtime-contracts";
import { CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT } from "@agent-workspace/provider-claude-code";
import { openCodeServerProtocolFingerprint } from "@agent-workspace/provider-opencode";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_PROVIDER_CONFIGURATION_ENV,
  RuntimeProviderConfigurationError,
  createRuntimeProviderPorts,
  loadRuntimeProviderPortsFromEnvironment,
  parseRuntimeProviderConfiguration,
} from "./provider-composition.js";

const PINS: Record<ProviderKind, { readonly providerVersion: string; readonly protocolFingerprint: string }> = {
  opencode: { providerVersion: "opencode-1.0.0", protocolFingerprint: "sha256:opencode-live-v1" },
  codex: { providerVersion: "codex-1.0.0", protocolFingerprint: "sha256:codex-live-v1" },
  "claude-code": { providerVersion: "claude-code-1.0.0", protocolFingerprint: "sha256:claude-code-live-v1" },
};

describe("Runtime Host Provider composition", () => {
  it("returns no ports for an unconfigured Host instead of installing fixture fallbacks", () => {
    expect(loadRuntimeProviderPortsFromEnvironment({ environment: {} })).toEqual([]);
  });

  it("composes the direct OpenCode Server transport only for OpenCode and pins its OpenAPI", async () => {
    const openApi = { openapi: "3.1.0", info: { title: "opencode", version: "1.0.0" }, paths: { "/session": { post: { operationId: "session.create" } } } };
    const pin = { providerVersion: "1.18.13", protocolFingerprint: openCodeServerProtocolFingerprint(openApi) };
    const calls: Array<{ readonly url: URL; readonly method: string }> = [];
    const ports = createRuntimeProviderPorts(parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{
        provider: "opencode",
        protocol: pin,
        transport: {
          kind: "opencode-server",
          baseUrl: { env: "OPENCODE_SERVER_URL" },
          headers: { authorization: { env: "OPENCODE_SERVER_AUTHORIZATION" } },
        },
      }],
    })), {
      environment: {
        OPENCODE_SERVER_URL: "http://127.0.0.1:47123",
        OPENCODE_SERVER_AUTHORIZATION: "Bearer host-only-token",
      },
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.pathname === "/global/health") return new Response(JSON.stringify({ healthy: true, version: "1.18.13" }), { status: 200 });
        if (url.pathname === "/doc") return new Response(JSON.stringify(openApi), { status: 200 });
        return new Response(null, { status: 404 });
      },
    });

    await expect(ports[0]!.describeCapabilities({ ...profile("opencode"), model: "opencode-go/gpt-5.6-luna", ...pin })).resolves.toMatchObject({
      available: true,
      capabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile"],
    });
    await expect(ports[0]!.describeCapabilities({
      ...profile("opencode", ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"]),
      model: "opencode-go/gpt-5.6-luna",
      ...pin,
    })).resolves.toMatchObject({
      available: false,
      unavailableReasons: ["capability_interrupt_unavailable"],
    });
    expect(calls).toEqual(expect.arrayContaining([
      { url: new URL("http://127.0.0.1:47123/global/health"), method: "GET" },
      { url: new URL("http://127.0.0.1:47123/doc"), method: "GET" },
    ]));

    const mismatched = parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{ provider: "codex", protocol: PINS.codex, transport: { kind: "opencode-server", baseUrl: "http://127.0.0.1:47123" } }],
    }));
    expect(() => createRuntimeProviderPorts(mismatched)).toThrow("runtime_provider_configuration_transport_provider_mismatch");
  });

  it("registers native Codex and Claude bridges only through their matching Provider and Host-private data directory", () => {
    const nativePin = { providerVersion: "0.146.0", protocolFingerprint: `sha256:${"a".repeat(64)}` };
    const claudePin = { providerVersion: "2.1.222", protocolFingerprint: CLAUDE_CODE_CLI_STREAM_PROTOCOL_FINGERPRINT };
    const configuration = parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [
        {
          provider: "codex",
          protocol: nativePin,
          transport: {
            kind: "codex-app-server",
            command: { env: "CODEX_COMMAND" },
            env: { CODEX_HOME: { env: "CODEX_HOME" }, PATH: { env: "HOST_PATH" } },
          },
        },
        {
          provider: "claude-code",
          protocol: claudePin,
          transport: {
            kind: "claude-code-stream",
            command: { env: "CLAUDE_COMMAND" },
            env: { HOME: { env: "CLAUDE_HOME" }, PATH: { env: "HOST_PATH" } },
          },
        },
      ],
    }));
    const options = {
      environment: {
        CODEX_COMMAND: "/opt/agent-workspace/bin/codex",
        CODEX_HOME: "/private/agent-workspace/codex-home",
        CLAUDE_COMMAND: "/opt/agent-workspace/bin/claude",
        CLAUDE_HOME: "/private/agent-workspace/claude-home",
        HOST_PATH: "/usr/bin:/bin",
      },
      runtimeDataDirectory: "/private/agent-workspace/runtime",
    };

    expect(createRuntimeProviderPorts(configuration, options).map((port) => port.provider)).toEqual(["codex", "claude-code"]);
    expect(() => createRuntimeProviderPorts(configuration, { environment: options.environment }))
      .toThrow("runtime_provider_configuration_runtime_data_directory_required");

    const mismatched = parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{
        provider: "opencode",
        protocol: nativePin,
        transport: { kind: "codex-app-server", command: "/opt/agent-workspace/bin/codex", env: { CODEX_HOME: { env: "CODEX_HOME" } } },
      }],
    }));
    expect(() => createRuntimeProviderPorts(mismatched, options)).toThrow("runtime_provider_configuration_transport_provider_mismatch");
  });

  it("keeps a configured Provider unavailable when its observed protocol does not match the pin", async () => {
    const ports = createRuntimeProviderPorts(parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{
        provider: "opencode",
        protocol: PINS.opencode,
        transport: { kind: "opencode-server", baseUrl: "http://127.0.0.1:4096" },
      }],
    })), {
      fetchFn: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/global/health") {
          return new Response(JSON.stringify({ healthy: true, version: PINS.opencode.providerVersion }), { status: 200 });
        }
        if (url.pathname === "/doc") {
          return new Response(JSON.stringify({ info: { version: PINS.opencode.providerVersion }, paths: { "/unexpected": {} } }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      },
    });

    await expect(ports[0]!.describeCapabilities(profile("opencode"))).resolves.toMatchObject({
      available: false,
      unavailableReasons: expect.arrayContaining(["adapter_protocolFingerprint_mismatch"]),
    });
  });

  it("rejects non-native transport configuration before any Provider port is created", () => {
    expect(() => parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{
        provider: "opencode",
        protocol: PINS.opencode,
        transport: {
          kind: "http-json",
          baseUrl: "http://127.0.0.1:4096",
          endpoints: { inspect_protocol: "/protocol" },
        },
      }],
    }))).toThrow("runtime_provider_configuration_transport_unsupported: providers[0].transport.kind");

    expect(() => parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{
        provider: "codex",
        protocol: PINS.codex,
        transport: {
          kind: "process-json",
          command: "codex-json",
          operations: ["inspect_protocol", "ensure_binding", "submit_delivery", "reconcile_binding"],
        },
      }],
    }))).toThrow("runtime_provider_configuration_transport_unsupported: providers[0].transport.kind");
  });

  it("rejects unpinned and inline-secret configuration without echoing secrets", () => {
    expect(() => parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{ provider: "opencode", transport: { kind: "opencode-server", baseUrl: "http://127.0.0.1:4096" } }],
    }))).toThrow(RuntimeProviderConfigurationError);

    const inlineSecret = "Bearer inline-secret-token";
    const inlineSecretFailure = captureFailure(() => parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{
        provider: "opencode",
        protocol: PINS.opencode,
        transport: {
          kind: "opencode-server",
          baseUrl: "http://127.0.0.1:4096",
          headers: { authorization: inlineSecret },
        },
      }],
    })));
    expect(inlineSecretFailure).toBeInstanceOf(RuntimeProviderConfigurationError);
    expect(inlineSecretFailure.message).not.toContain(inlineSecret);

    const configuration = parseRuntimeProviderConfiguration(JSON.stringify({
      schemaVersion: 1,
      providers: [{
        provider: "opencode",
        protocol: PINS.opencode,
        transport: {
          kind: "opencode-server",
          baseUrl: { env: "OPENCODE_BASE_URL" },
          headers: { authorization: { env: "OPENCODE_TOKEN" } },
        },
      }],
    }));
    const secret = "not-a-url-with-a-secret-token";
    const failure = captureFailure(() => createRuntimeProviderPorts(configuration, {
      environment: { OPENCODE_BASE_URL: secret, OPENCODE_TOKEN: "real-secret-token" },
    }));
    expect(failure).toBeInstanceOf(RuntimeProviderConfigurationError);
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain("real-secret-token");
  });

});

function profile(provider: ProviderKind, requiredCapabilities: ExecutionProfileDefinition["capabilityPolicy"]["requiredCapabilities"] = ["create_binding"]): ExecutionProfileDefinition {
  const pin = PINS[provider];
  return {
    executionProfileId: `profile_${provider.replace("-", "_")}`,
    provider,
    model: "host-composition-test",
    providerVersion: pin.providerVersion,
    protocolFingerprint: pin.protocolFingerprint,
    capabilityPolicy: {
      requiredCapabilities,
      allowedTools: [],
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function captureFailure(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected_configuration_failure");
}
