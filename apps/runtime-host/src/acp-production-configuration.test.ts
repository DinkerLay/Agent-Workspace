import { describe, expect, it } from "vitest";
import type { MetaProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import {
  RUNTIME_ACP_CONFIGURATION_ENV,
  createAcpProductionHostInputs,
  loadAcpProductionConfigurationFromEnvironment,
  parseAcpProductionConfiguration,
} from "./acp-production-configuration.js";

const META_PROFILE: MetaProfileDefinitionV3 = {
  metaProfileId: "meta_profile_production-codex",
  profileRevisionId: "profile_revision_meta-production-codex-v1",
  providerFamily: "codex",
  acpAgentKind: "codex_acp",
  protocolMajor: 1,
  role: "meta",
  model: "openai/current-meta-model",
  configIntent: { reasoningEffort: "high" },
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
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

describe("production ACP Host configuration", () => {
  it("accepts only current-install references and portable Meta Profiles", () => {
    const configuration = parseAcpProductionConfiguration(JSON.stringify(validConfiguration()));

    expect(configuration).toEqual(validConfiguration());
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.agents)).toBe(true);
    expect(Object.isFrozen(configuration.agents.opencode)).toBe(true);
    expect(Object.isFrozen(configuration.agents.codex)).toBe(true);
    expect(Object.isFrozen(configuration.agents.claudeCode)).toBe(true);
    expect(Object.isFrozen(configuration.metaProfiles)).toBe(true);
    expect(Object.isFrozen(configuration.metaProfiles[0]?.profile)).toBe(true);

    const serialized = JSON.stringify(configuration);
    expect(serialized).not.toMatch(
      /providerVersion|protocolFingerprint|artifactDigest|qualification|baseUrl|app-server|stream-json|expectedVersion|rawSessionId|cwd/,
    );
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("raw-secret");
  });

  it("rejects direct transports, local values, resolution pins and serialized qualifications", () => {
    const base = validConfiguration();
    const invalid: readonly unknown[] = [
      { ...base, providerVersion: "1.18.13" },
      { ...base, expectedArtifactDigest: "sha256:deadbeef" },
      { ...base, qualification: { available: true } },
      { ...base, agents: { ...base.agents, opencode: {
        ...base.agents.opencode,
        command: "/opt/homebrew/bin/opencode",
      } } },
      { ...base, agents: { ...base.agents, opencode: {
        ...base.agents.opencode,
        baseUrl: "http://127.0.0.1:4096",
      } } },
      { ...base, agents: { ...base.agents, codex: {
        ...base.agents.codex,
        kind: "codex-app-server",
      } } },
      { ...base, agents: { ...base.agents, claudeCode: {
        ...base.agents.claudeCode,
        kind: "claude-code-stream",
      } } },
      { ...base, metaProfiles: [{
        ...base.metaProfiles[0],
        profile: { ...META_PROFILE, providerVersion: "0.147.0" },
      }] },
    ];

    for (const candidate of invalid) {
      expect(() => parseAcpProductionConfiguration(JSON.stringify(candidate)))
        .toThrow();
    }
  });

  it("requires exact unique agent/profile identities and a configured matching current-install agent", () => {
    const base = validConfiguration();
    expect(() => parseAcpProductionConfiguration(JSON.stringify({
      ...base,
      agents: { opencode: base.agents.opencode },
      metaProfiles: base.metaProfiles,
    }))).toThrow(/meta.*agent|agent.*not.*configured/i);
    expect(() => parseAcpProductionConfiguration(JSON.stringify({
      ...base,
      metaProfiles: [base.metaProfiles[0], base.metaProfiles[0]],
    }))).toThrow(/duplicate/i);
    expect(() => parseAcpProductionConfiguration(JSON.stringify({
      ...base,
      metaProfiles: [{
        ...base.metaProfiles[0],
        profile: {
          ...META_PROFILE,
          providerFamily: "opencode",
          acpAgentKind: "codex_acp",
        },
      }],
    }))).toThrow();
  });

  it("uses one explicit environment variable and treats omission as no configured local agents", () => {
    expect(loadAcpProductionConfigurationFromEnvironment({})).toEqual({
      schemaVersion: 1,
      agents: {},
      metaProfiles: [],
    });
    expect(loadAcpProductionConfigurationFromEnvironment({
      [RUNTIME_ACP_CONFIGURATION_ENV]: JSON.stringify(validConfiguration()),
    })).toEqual(validConfiguration());
    expect(() => loadAcpProductionConfigurationFromEnvironment({
      [RUNTIME_ACP_CONFIGURATION_ENV]: "not-json",
    })).toThrow(/invalid_json/);
  });

  it("never resolves or copies referenced environment values while parsing", () => {
    const environment = {
      [RUNTIME_ACP_CONFIGURATION_ENV]: JSON.stringify(validConfiguration()),
      AGENT_WORKSPACE_OPENCODE_COMMAND: "/private/install/opencode",
      AGENT_WORKSPACE_OPENCODE_AUTH: "/private/credential/auth.json",
      AGENT_WORKSPACE_CODEX_AUTH: "raw-secret",
    };
    const configuration = loadAcpProductionConfigurationFromEnvironment(environment);
    const serialized = JSON.stringify(configuration);

    expect(serialized).toContain("AGENT_WORKSPACE_OPENCODE_COMMAND");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("raw-secret");
  });

  it("freezes Host-private referenced values once and redacts them from serialization", () => {
    const environment: Record<string, string> = {
      AGENT_WORKSPACE_OPENCODE_COMMAND: "/private/install/opencode",
      AGENT_WORKSPACE_OPENCODE_AUTH: "/private/credential/opencode.json",
      AGENT_WORKSPACE_CODEX_ACP_WRAPPER: "/private/install/codex-acp",
      AGENT_WORKSPACE_CODEX_COMMAND: "/private/install/codex",
      AGENT_WORKSPACE_NODE_COMMAND: "/private/install/node",
      AGENT_WORKSPACE_CODEX_AUTH: "/private/credential/codex.json",
      AGENT_WORKSPACE_CLAUDE_AGENT_ACP_WRAPPER: "/private/install/claude-agent-acp",
      AGENT_WORKSPACE_CLAUDE_COMMAND: "/private/install/claude",
      AGENT_WORKSPACE_CLAUDE_SETTINGS: "/private/credential/claude-settings.json",
      AGENT_WORKSPACE_ACP_SEARCH_PATH: "/private/bin:/usr/bin:/bin",
    };
    const inputs = createAcpProductionHostInputs(
      parseAcpProductionConfiguration(JSON.stringify(validConfiguration())),
      environment,
    );
    environment.AGENT_WORKSPACE_OPENCODE_COMMAND = "/private/drifted/opencode";

    expect(inputs.openCode()).toEqual({
      commandReference: "/private/install/opencode",
      executableSearchPath: "/private/bin:/usr/bin:/bin",
      authFile: "/private/credential/opencode.json",
    });
    expect(inputs.codex()).toEqual({
      wrapperCommandReference: "/private/install/codex-acp",
      codexCommandReference: "/private/install/codex",
      nodeCommandReference: "/private/install/node",
      executableSearchPath: "/private/bin:/usr/bin:/bin",
      authFile: "/private/credential/codex.json",
    });
    expect(inputs.claudeCode()).toEqual({
      wrapperCommandReference: "/private/install/claude-agent-acp",
      claudeCommandReference: "/private/install/claude",
      nodeCommandReference: "/private/install/node",
      executableSearchPath: "/private/bin:/usr/bin:/bin",
      settingsFile: "/private/credential/claude-settings.json",
    });
    expect(JSON.stringify(inputs)).toBe('{"kind":"acp_production_host_inputs"}');
  });

  it("rejects a configured missing or blank Host reference before composition", () => {
    const configuration = parseAcpProductionConfiguration(JSON.stringify(validConfiguration()));
    expect(() => createAcpProductionHostInputs(configuration, {}))
      .toThrow(/environment_reference_missing/);
    expect(() => createAcpProductionHostInputs(configuration, {
      AGENT_WORKSPACE_OPENCODE_COMMAND: "\u0000",
      AGENT_WORKSPACE_OPENCODE_AUTH: "/auth",
      AGENT_WORKSPACE_CODEX_ACP_WRAPPER: "/wrapper",
      AGENT_WORKSPACE_CODEX_COMMAND: "/codex",
      AGENT_WORKSPACE_NODE_COMMAND: "/node",
      AGENT_WORKSPACE_CODEX_AUTH: "/auth",
      AGENT_WORKSPACE_CLAUDE_AGENT_ACP_WRAPPER: "/wrapper",
      AGENT_WORKSPACE_CLAUDE_COMMAND: "/claude",
      AGENT_WORKSPACE_CLAUDE_SETTINGS: "/settings",
      AGENT_WORKSPACE_ACP_SEARCH_PATH: "/bin",
    })).toThrow(/environment_reference_invalid/);
  });
});

function validConfiguration() {
  return {
    schemaVersion: 1,
    agents: {
      opencode: {
        kind: "opencode-acp-current-install",
        command: { env: "AGENT_WORKSPACE_OPENCODE_COMMAND" },
        executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
        authFile: { env: "AGENT_WORKSPACE_OPENCODE_AUTH" },
      },
      codex: {
        kind: "codex-acp-current-install",
        wrapperCommand: { env: "AGENT_WORKSPACE_CODEX_ACP_WRAPPER" },
        codexCommand: { env: "AGENT_WORKSPACE_CODEX_COMMAND" },
        nodeCommand: { env: "AGENT_WORKSPACE_NODE_COMMAND" },
        executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
        authFile: { env: "AGENT_WORKSPACE_CODEX_AUTH" },
      },
      claudeCode: {
        kind: "claude-agent-acp-current-install",
        wrapperCommand: { env: "AGENT_WORKSPACE_CLAUDE_AGENT_ACP_WRAPPER" },
        claudeCommand: { env: "AGENT_WORKSPACE_CLAUDE_COMMAND" },
        nodeCommand: { env: "AGENT_WORKSPACE_NODE_COMMAND" },
        executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
        settingsFile: { env: "AGENT_WORKSPACE_CLAUDE_SETTINGS" },
      },
    },
    metaProfiles: [{
      metaProfileOptionId: "meta_profile_option_production-codex",
      title: "Current Codex ACP Meta",
      profile: META_PROFILE,
    }],
  } as const;
}
