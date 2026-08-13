import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAcpProductionConfiguration } from "./acp-production-configuration.js";
import { createSessionIdAcpProviderSettingsHost } from "./session-id-acp-provider-settings-host.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Session-ID ACP Provider settings Host", () => {
  it("discovers each local component without launching a Provider or reading credential content", () => {
    const fixture = localFixture();
    const host = createSessionIdAcpProviderSettingsHost({
      runtimeDataDirectory: fixture.runtime,
      environment: fixture.environment,
    });

    expect(host.read("opencode").installation.status).toBe("not_scanned");
    expect(host.discover("opencode")).toMatchObject({
      configurationSource: "none",
      installation: {
        status: "ready",
        components: [
          { kind: "provider_cli", status: "found" },
          { kind: "credential_source", status: "found" },
        ],
      },
    });
    expect(host.discover("codex").installation).toMatchObject({
      status: "ready",
      components: [
        { kind: "provider_cli", status: "found" },
        { kind: "node", status: "found" },
        { kind: "credential_source", status: "found" },
      ],
    });
    expect(host.discover("codex").installation.components.map(({ kind }) => kind))
      .not.toContain("acp_agent");
    expect(host.toJSON()).toEqual({ kind: "session_id_acp_provider_settings_host" });
  });

  it("persists a user-selected installation privately and applies it to future Provider generations immediately", () => {
    const fixture = localFixture();
    const first = createSessionIdAcpProviderSettingsHost({
      runtimeDataDirectory: fixture.runtime,
      environment: fixture.environment,
    });
    const configured = first.configure("opencode", {
      kind: "opencode",
      commandPath: fixture.opencode,
      authFilePath: fixture.opencodeAuth,
    });
    expect(configured).toMatchObject({ configurationSource: "local" });
    const effective = first.effectiveEnvironment();
    expect(parseAcpProductionConfiguration(effective.AGENT_WORKSPACE_ACP_CONFIG!)).toMatchObject({
      agents: { opencode: { kind: "opencode-acp-current-install" } },
    });

    const settingsFile = path.join(fixture.runtime, "acp-provider-settings.json");
    expect(readFileSync(settingsFile, "utf8")).not.toContain("auth-token-must-not-be-read-or-copied");

    const second = createSessionIdAcpProviderSettingsHost({
      runtimeDataDirectory: fixture.runtime,
      environment: fixture.environment,
    });
    const serialized = second.effectiveEnvironment().AGENT_WORKSPACE_ACP_CONFIG;
    expect(serialized).toBeTruthy();
    expect(parseAcpProductionConfiguration(serialized!)).toMatchObject({
      agents: { opencode: { kind: "opencode-acp-current-install" } },
    });
    expect(second.read("opencode")).toMatchObject({
      configurationSource: "local",
    });
  });

  it("persists an observed Chat model selection and emits effort-specific future Meta profiles", () => {
    const fixture = localFixture();
    const first = createSessionIdAcpProviderSettingsHost({
      runtimeDataDirectory: fixture.runtime,
      environment: fixture.environment,
    });
    first.configure("opencode", {
      kind: "opencode",
      commandPath: fixture.opencode,
      authFilePath: fixture.opencodeAuth,
    });
    first.recordModelCatalog("opencode", Object.freeze([
      Object.freeze({ modelId: "opencode-go/gpt-5.6-luna", label: "GPT-5.6 Luna" }),
    ]));
    expect(first.configureChatModels(
      "opencode",
      Object.freeze(["opencode-go/gpt-5.6-luna"]),
      "opencode-go/gpt-5.6-luna",
    )).toMatchObject({
      defaultModelId: "opencode-go/gpt-5.6-luna",
      enabledChatModelIds: ["opencode-go/gpt-5.6-luna"],
    });
    const configuration = parseAcpProductionConfiguration(
      first.effectiveEnvironment().AGENT_WORKSPACE_ACP_CONFIG!,
    );
    expect(configuration.metaProfiles).toHaveLength(1);
    expect(configuration.metaProfiles[0]?.profile).toMatchObject({
      providerFamily: "opencode",
      role: "meta",
      model: "opencode-go/gpt-5.6-luna",
    });

    first.configure("codex", {
      kind: "codex",
      codexPath: fixture.codex,
      nodePath: fixture.node,
      authFilePath: fixture.codexAuth,
    });
    first.recordModelCatalog("codex", Object.freeze([
      Object.freeze({ modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" }),
    ]));
    first.configureChatModels("codex", ["gpt-5.6-luna"], "gpt-5.6-luna");
    const withCodex = parseAcpProductionConfiguration(first.effectiveEnvironment().AGENT_WORKSPACE_ACP_CONFIG!);
    const codexProfiles = withCodex.metaProfiles.filter((entry) => entry.profile.providerFamily === "codex");
    expect(codexProfiles.map((entry) => entry.profile.configIntent)).toEqual([
      {},
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
    ]);
  });

  it("keeps an operator environment configuration authoritative", () => {
    const fixture = localFixture();
    const host = createSessionIdAcpProviderSettingsHost({
      runtimeDataDirectory: fixture.runtime,
      environment: {
        ...fixture.environment,
        AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify({ schemaVersion: 1, agents: {}, metaProfiles: [] }),
      },
    });
    expect(host.read("codex").configurationSource).toBe("environment");
    expect(() => host.configure("codex", {
      kind: "codex",
      codexPath: fixture.codex,
      nodePath: fixture.node,
      authFilePath: fixture.codexAuth,
    })).toThrowError("session_id_acp_provider_environment_managed");
  });

  it("uses Agent Workspace-managed Codex and Claude ACP servers without exposing their paths as user settings", () => {
    const fixture = localFixture();
    const host = createSessionIdAcpProviderSettingsHost({
      runtimeDataDirectory: fixture.runtime,
      environment: fixture.environment,
    });

    host.configure("codex", {
      kind: "codex",
      codexPath: fixture.codex,
      nodePath: fixture.node,
      authFilePath: fixture.codexAuth,
    });
    const effective = host.effectiveEnvironment();
    expect(effective.AGENT_WORKSPACE_LOCAL_CODEX_ACP_WRAPPER).toMatch(
      /node_modules\/@agentclientprotocol\/codex-acp\/dist\/index\.js$/u,
    );
    expect(host.read("codex").installation.components.map(({ kind }) => kind)).toEqual([
      "provider_cli",
      "node",
      "credential_source",
    ]);
    expect(JSON.stringify(host.read("codex"))).not.toContain("codex-acp");
  });
});

function localFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-workspace-provider-settings-"));
  roots.push(root);
  const runtime = path.join(root, "runtime");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(path.join(home, ".local/share/opencode"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
  const executable = (name: string) => {
    const file = path.join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return file;
  };
  const opencode = executable("opencode");
  const codex = executable("codex");
  const node = executable("node");
  const opencodeAuth = path.join(home, ".local/share/opencode/auth.json");
  const codexAuth = path.join(home, ".codex/auth.json");
  writeFileSync(opencodeAuth, "auth-token-must-not-be-read-or-copied", { mode: 0o600 });
  writeFileSync(codexAuth, "codex-secret", { mode: 0o600 });
  chmodSync(runtime, 0o700);
  return {
    runtime,
    opencode,
    codex,
    node,
    opencodeAuth,
    codexAuth,
    environment: { HOME: home, PATH: bin },
  };
}
