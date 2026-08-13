import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import { createAcpProfileResolutionRegistry } from "./acp-profile-resolution.js";
import {
  beginClaudeCodeAcpCredentialAcquisition,
  createClaudeCodeAcpCurrentInstallDescriptor,
  type ClaudeCodeAcpCurrentInstallOptions,
} from "./acp-claude-code-resolution.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

describe("Claude Code ACP current-install resolution", () => {
  it("seals the official wrapper, exact Claude/Node entries, and sanitized CCSwitch routing", async () => {
    const install = await createInstall();
    const descriptor = createClaudeCodeAcpCurrentInstallDescriptor(
      descriptorOptions(install),
    );
    const artifact = await descriptor.discoverCurrent(profile());

    expect(artifact).toMatchObject({
      canonicalLauncherPath: await realpath(install.wrapperArtifact),
      launchArguments: [],
      observedArtifactVersion: "0.66.0",
      observedUpstreamVersion: "5.0.1",
      trustState: "trusted",
      environment: {
        PATH: install.bin,
        CLAUDE_CODE_EXECUTABLE: await realpath(install.claudeArtifact),
        NO_BROWSER: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });
    expect(Object.keys(artifact.environment).sort()).toEqual([
      "CLAUDE_CODE_EXECUTABLE",
      "LANG",
      "LC_ALL",
      "NO_BROWSER",
      "PATH",
    ]);

    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
    await expect(resolution.assertCurrent()).resolves.toBeUndefined();
    await writeFile(install.settingsFile, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://gateway-b.example", ENABLE_TOOL_SEARCH: "false" },
    }), { mode: 0o600 });
    await expect(resolution.assertCurrent()).rejects.toMatchObject({
      code: "acp_current_artifact_drift",
    });
  });

  it("reads the leading version token from the real Claude Code version shape", async () => {
    const install = await createInstall();
    await writeFile(install.claudeArtifact, "#!/bin/sh\nprintf '2.1.228 (Claude Code)\\n'\n", { mode: 0o700 });
    const descriptor = createClaudeCodeAcpCurrentInstallDescriptor({
      ...descriptorOptions(install),
      inspectClaudeCodeVersion: undefined,
    });

    await expect(descriptor.discoverCurrent(profile())).resolves.toMatchObject({
      observedUpstreamVersion: "2.1.228",
    });
  });

  it("creates an isolated Claude config containing only approved routing keys", async () => {
    const install = await createInstall();
    const runtimePrivateRoot = path.join(install.root, "runtime-private");
    await mkdir(runtimePrivateRoot, { mode: 0o700 });
    const operation = beginClaudeCodeAcpCredentialAcquisition({
      privateRootParent: runtimePrivateRoot,
      sourceSettingsFile: install.settingsFile,
    });
    const lease = await operation.lease;

    expect(lease.environment).toEqual({
      HOME: expect.any(String),
      CLAUDE_CONFIG_DIR: expect.any(String),
      TMPDIR: expect.any(String),
      ANTHROPIC_BASE_URL: "https://gateway-a.example",
      ANTHROPIC_AUTH_TOKEN: "private-token",
      ANTHROPIC_MODEL: "claude-opus-5",
      ENABLE_TOOL_SEARCH: "false",
    });
    expect(lease.environment).not.toHaveProperty("PATH");
    expect(lease.environment).not.toHaveProperty("NO_BROWSER");
    const copied = JSON.parse(await readFile(
      path.join(lease.environment.CLAUDE_CONFIG_DIR!, "settings.json"),
      "utf8",
    ));
    expect(copied).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://gateway-a.example",
        ANTHROPIC_AUTH_TOKEN: "private-token",
        ANTHROPIC_MODEL: "claude-opus-5",
        ENABLE_TOOL_SEARCH: "false",
      },
      model: "claude-opus-5",
    });
    expect(copied).not.toHaveProperty("permissions");
    expect(copied).not.toHaveProperty("hooks");
    expect(copied).not.toHaveProperty("mcpServers");

    const privateGenerationRoot = path.dirname(lease.environment.CLAUDE_CONFIG_DIR!);
    await lease.revoke();
    await expect(realpath(privateGenerationRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function profile(): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "execution_profile_claude_code_acp",
    profileRevisionId: "profile_revision_claude_code_acp_v1",
    providerFamily: "claude-code",
    acpAgentKind: "claude_agent_acp",
    protocolMajor: 1,
    model: "claude-opus-5",
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
      permissionMode: "preapproved",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

async function createInstall() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-claude-code-acp-"));
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const artifacts = path.join(root, "artifacts");
  await mkdir(bin, { mode: 0o700 });
  await mkdir(artifacts, { mode: 0o700 });
  const wrapperArtifact = path.join(artifacts, "claude-agent-acp.js");
  const claudeArtifact = path.join(artifacts, "claude");
  const nodeArtifact = path.join(artifacts, "node");
  const wrapperCommand = path.join(bin, "claude-agent-acp");
  const claudeCommand = path.join(bin, "claude");
  const nodeCommand = path.join(bin, "node");
  const settingsFile = path.join(root, "settings.json");
  await writeFile(wrapperArtifact, "#!/usr/bin/env node\n// wrapper\n", { mode: 0o700 });
  await writeFile(claudeArtifact, "#!/bin/sh\n# claude\n", { mode: 0o700 });
  await writeFile(nodeArtifact, "fake node\n", { mode: 0o700 });
  await Promise.all([
    chmod(wrapperArtifact, 0o700),
    chmod(claudeArtifact, 0o700),
    chmod(nodeArtifact, 0o700),
  ]);
  await Promise.all([
    symlink(wrapperArtifact, wrapperCommand),
    symlink(claudeArtifact, claudeCommand),
    symlink(nodeArtifact, nodeCommand),
  ]);
  await writeFile(settingsFile, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://gateway-a.example",
      ANTHROPIC_AUTH_TOKEN: "private-token",
      ANTHROPIC_MODEL: "claude-opus-5",
      ENABLE_TOOL_SEARCH: "false",
      PATH: "/must-not-pass",
      ANTHROPIC_CONFIG_DIR: "/must-not-pass",
      ANTHROPIC_TOKEN_FILE: "/must-not-pass",
    },
    model: "claude-opus-5",
    permissions: { defaultMode: "bypassPermissions" },
    hooks: { preToolUse: ["must-not-pass"] },
    mcpServers: { ambient: {} },
  }), { mode: 0o600 });
  return {
    root,
    bin,
    wrapperArtifact,
    wrapperCommand,
    claudeArtifact,
    claudeCommand,
    nodeArtifact,
    nodeCommand,
    settingsFile,
  };
}

function descriptorOptions(
  install: Awaited<ReturnType<typeof createInstall>>,
): ClaudeCodeAcpCurrentInstallOptions {
  return {
    wrapperCommandReference: install.wrapperCommand,
    claudeCommandReference: install.claudeCommand,
    nodeCommandReference: install.nodeCommand,
    executableSearchPath: install.bin,
    settingsSourcePath: install.settingsFile,
    inspectWrapperVersion: async () => "0.66.0",
    inspectClaudeCodeVersion: async () => "5.0.1",
    inspectNodeVersion: async () => "v25.0.0",
    trustArtifact: async () => true,
  };
}
