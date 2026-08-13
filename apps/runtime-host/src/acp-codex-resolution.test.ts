import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionProfileDefinitionV3,
  MetaProfileDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import { createAcpProfileResolutionRegistry } from "./acp-profile-resolution.js";
import {
  beginCodexAcpCredentialAcquisition,
  createCodexAcpCurrentInstallDescriptor,
  createCodexAcpMetaCurrentInstallDescriptor,
  type CodexAcpCurrentInstallOptions,
} from "./acp-codex-resolution.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

function profile(): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "execution_profile_codex_acp" as ExecutionProfileDefinitionV3["executionProfileId"],
    profileRevisionId: "profile_revision_codex_acp",
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    protocolMajor: 1,
    model: "provider/model-current",
    configIntent: {},
    requiredExtensions: ["session/load"],
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

function metaProfile(): MetaProfileDefinitionV3 {
  const taskProfile = profile();
  return {
    metaProfileId: "meta_profile_codex_acp" as MetaProfileDefinitionV3["metaProfileId"],
    profileRevisionId: "profile_revision_codex_meta_acp",
    providerFamily: taskProfile.providerFamily,
    acpAgentKind: taskProfile.acpAgentKind,
    protocolMajor: taskProfile.protocolMajor,
    role: "meta",
    model: taskProfile.model,
    configIntent: taskProfile.configIntent,
    requiredExtensions: taskProfile.requiredExtensions,
    capabilityPolicy: taskProfile.capabilityPolicy,
  };
}

async function createInstall() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-codex-acp-resolution-"));
  const bin = path.join(root, "bin");
  const artifacts = path.join(root, "artifacts");
  const wrapperArtifact = path.join(artifacts, "index.js");
  const codexArtifact = path.join(artifacts, "codex-current");
  const nodeArtifact = path.join(artifacts, "node");
  const wrapperCommand = path.join(bin, "codex-acp");
  const codexCommand = path.join(bin, "codex");
  const nodeCommand = path.join(bin, "node");
  temporaryRoots.push(root);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  await writeFile(wrapperArtifact, "#!/usr/bin/env node\n// codex-acp wrapper A\n", { mode: 0o700 });
  await writeFile(codexArtifact, "#!/bin/sh\n# current codex A\n", { mode: 0o700 });
  await writeFile(nodeArtifact, "fake exact node runtime A\n", { mode: 0o700 });
  await Promise.all([
    chmod(wrapperArtifact, 0o700),
    chmod(codexArtifact, 0o700),
    chmod(nodeArtifact, 0o700),
  ]);
  await symlink(wrapperArtifact, wrapperCommand);
  await symlink(codexArtifact, codexCommand);
  await symlink(nodeArtifact, nodeCommand);
  return {
    artifacts,
    bin,
    codexArtifact,
    codexCommand,
    nodeArtifact,
    nodeCommand,
    root,
    wrapperArtifact,
    wrapperCommand,
  };
}

function descriptorOptions(
  install: Awaited<ReturnType<typeof createInstall>>,
  overrides: Partial<CodexAcpCurrentInstallOptions> = {},
): CodexAcpCurrentInstallOptions {
  return {
    wrapperCommandReference: install.wrapperCommand,
    codexCommandReference: install.codexCommand,
    nodeCommandReference: install.nodeCommand,
    executableSearchPath: install.bin,
    inspectWrapperVersion: async () => "2099.1.0-wrapper-future",
    inspectCodexVersion: async () => "2099.2.0-codex-future",
    inspectNodeVersion: async () => "v99.0.0-future",
    trustArtifact: async () => true,
    ...overrides,
  };
}

function permissionBits(mode: number): number {
  return mode & 0o777;
}

describe("Codex ACP composite current-install descriptor", () => {
  it("admits only a Codex Meta Profile through its independent descriptor", async () => {
    const install = await createInstall();
    const descriptor = createCodexAcpMetaCurrentInstallDescriptor(descriptorOptions(install));
    const artifact = await descriptor.discoverCurrent(metaProfile());

    expect(artifact.observedArtifactVersion).toBe("2099.1.0-wrapper-future");
    expect(artifact.observedUpstreamVersion).toBe("2099.2.0-codex-future");
    await expect(Reflect.apply(
      descriptor.discoverCurrent,
      descriptor,
      [profile()],
    )).rejects.toMatchObject({ code: "codex_acp_meta_profile_mismatch" });
  });

  it("seals wrapper, exact node runtime, and explicit current Codex without a version allowlist", async () => {
    const install = await createInstall();
    vi.stubEnv("AGENT_WORKSPACE_AMBIENT_SECRET", "must-not-propagate");
    const inspections: Array<Readonly<{ kind: string; environment: Readonly<Record<string, string>> }>> = [];
    const descriptor = createCodexAcpCurrentInstallDescriptor(descriptorOptions(install, {
      inspectWrapperVersion: async (input) => {
        inspections.push({ kind: "wrapper", environment: input.environment });
        return "2099.1.0-wrapper-future";
      },
      inspectCodexVersion: async (input) => {
        inspections.push({ kind: "codex", environment: input.environment });
        return "2099.2.0-codex-future";
      },
      inspectNodeVersion: async (input) => {
        inspections.push({ kind: "node", environment: input.environment });
        return "v99.0.0-future";
      },
    }));
    const artifact = await descriptor.discoverCurrent(profile());
    const canonicalCodex = await realpath(install.codexArtifact);

    expect(artifact).toMatchObject({
      canonicalLauncherPath: await realpath(install.wrapperArtifact),
      launchArguments: [],
      observedArtifactVersion: "2099.1.0-wrapper-future",
      observedUpstreamVersion: "2099.2.0-codex-future",
      trustState: "trusted",
      environment: {
        PATH: install.bin,
        CODEX_PATH: canonicalCodex,
        CODEX_DISABLE_UPDATE_CHECK: "1",
        NO_BROWSER: "1",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
    });
    expect(artifact.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(artifact.executionConfigDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(artifact.launchArguments).not.toContain("app-server");
    expect(Object.keys(artifact.environment).sort()).toEqual([
      "CODEX_DISABLE_UPDATE_CHECK",
      "CODEX_PATH",
      "LANG",
      "LC_ALL",
      "NO_BROWSER",
      "PATH",
    ]);
    expect(inspections).toHaveLength(3);
    for (const inspection of inspections) {
      expect(inspection.environment).toEqual(artifact.environment);
      expect(inspection.environment).not.toHaveProperty("AGENT_WORKSPACE_AMBIENT_SECRET");
    }

    const resolution = await createAcpProfileResolutionRegistry({
      createOpaqueId: () => "acp_resolution_private_codex",
      now: () => "2026-08-12T00:00:00.000Z",
    }).resolve(profile(), descriptor);
    expect(resolution.safeObservation()).toMatchObject({
      observedArtifactVersion: "2099.1.0-wrapper-future",
      observedUpstreamVersion: "2099.2.0-codex-future",
      trust: "trusted",
    });
    const serialized = JSON.stringify(resolution);
    expect(serialized).not.toContain(install.root);
    expect(serialized).not.toContain(artifact.artifactDigest);
  });

  it.each(["wrapper", "codex", "node"] as const)(
    "invalidates the old resolution when the same-path %s artifact drifts",
    async (kind) => {
      const install = await createInstall();
      const descriptor = createCodexAcpCurrentInstallDescriptor(descriptorOptions(install));
      const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
      await expect(resolution.assertCurrent()).resolves.toBeUndefined();

      const artifactPath = kind === "wrapper"
        ? install.wrapperArtifact
        : kind === "codex"
          ? install.codexArtifact
          : install.nodeArtifact;
      const nextContents = kind === "wrapper"
        ? "#!/usr/bin/env node\n// codex-acp wrapper B\n"
        : `${kind} current artifact B\n`;
      await writeFile(artifactPath, nextContents, { mode: 0o700 });
      await chmod(artifactPath, 0o700);

      await expect(resolution.assertCurrent()).rejects.toMatchObject({
        code: "acp_current_artifact_drift",
      });
      const next = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
      expect(next.safeObservation()).toMatchObject({
        observedArtifactVersion: "2099.1.0-wrapper-future",
        observedUpstreamVersion: "2099.2.0-codex-future",
      });
    },
  );

  it("treats observed versions as drift evidence and accepts unknown replacements after re-resolution", async () => {
    const install = await createInstall();
    let wrapperVersion = "3100.1.0-unknown";
    let codexVersion = "3100.2.0-unknown";
    let nodeVersion = "v3100.3.0-unknown";
    const descriptor = createCodexAcpCurrentInstallDescriptor(descriptorOptions(install, {
      inspectWrapperVersion: async () => wrapperVersion,
      inspectCodexVersion: async () => codexVersion,
      inspectNodeVersion: async () => nodeVersion,
    }));
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
    await expect(resolution.assertCurrent()).resolves.toBeUndefined();

    wrapperVersion = "4100.1.0-newer-unknown";
    codexVersion = "4100.2.0-newer-unknown";
    nodeVersion = "v4100.3.0-newer-unknown";
    await expect(resolution.assertCurrent()).rejects.toMatchObject({
      code: "acp_current_artifact_drift",
    });

    const next = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
    expect(next.safeObservation()).toMatchObject({
      observedArtifactVersion: "4100.1.0-newer-unknown",
      observedUpstreamVersion: "4100.2.0-newer-unknown",
      trust: "trusted",
    });
  });

  it("fails closed for missing or untrusted wrapper and never uses the wrapper's bundled Codex fallback", async () => {
    const install = await createInstall();
    await expect(createCodexAcpCurrentInstallDescriptor(descriptorOptions(install, {
      wrapperCommandReference: path.join(install.bin, "missing-codex-acp"),
    })).discoverCurrent(profile())).rejects.toMatchObject({
      code: "codex_acp_wrapper_not_found",
    });

    const inspectWrapperVersion = vi.fn(async () => "must-not-execute");
    await expect(createCodexAcpCurrentInstallDescriptor(descriptorOptions(install, {
      inspectWrapperVersion,
      trustArtifact: async ({ kind }) => kind !== "wrapper",
    })).discoverCurrent(profile())).rejects.toMatchObject({
      code: "codex_acp_wrapper_untrusted",
    });
    expect(inspectWrapperVersion).not.toHaveBeenCalled();

    await expect(createCodexAcpCurrentInstallDescriptor(descriptorOptions(install, {
      codexCommandReference: path.join(install.bin, "missing-codex"),
    })).discoverCurrent(profile())).rejects.toMatchObject({
      code: "codex_acp_upstream_not_found",
    });
  });

  it("rejects a non-node shebang, a PATH/runtime mismatch, and a non-Codex Profile", async () => {
    const install = await createInstall();
    await writeFile(install.wrapperArtifact, "#!/usr/bin/node\n// unsafe implicit runtime\n", { mode: 0o700 });
    await expect(createCodexAcpCurrentInstallDescriptor(
      descriptorOptions(install),
    ).discoverCurrent(profile())).rejects.toMatchObject({
      code: "codex_acp_wrapper_shebang_unsupported",
    });

    await writeFile(install.wrapperArtifact, "#!/usr/bin/env node\n// wrapper restored\n", { mode: 0o700 });
    const otherNode = path.join(install.artifacts, "node-other");
    await writeFile(otherNode, "other explicit node runtime\n", { mode: 0o700 });
    await expect(createCodexAcpCurrentInstallDescriptor(descriptorOptions(install, {
      nodeCommandReference: otherNode,
    })).discoverCurrent(profile())).rejects.toMatchObject({
      code: "codex_acp_node_path_mismatch",
    });

    await expect(createCodexAcpCurrentInstallDescriptor(
      descriptorOptions(install),
    ).discoverCurrent({ ...profile(), providerFamily: "opencode" })).rejects.toMatchObject({
      code: "codex_acp_profile_mismatch",
    });
    const taskDescriptor = createCodexAcpCurrentInstallDescriptor(descriptorOptions(install));
    await expect(Reflect.apply(
      taskDescriptor.discoverCurrent,
      taskDescriptor,
      [metaProfile()],
    )).rejects.toMatchObject({ code: "codex_acp_profile_mismatch" });
  });
});

describe("Codex ACP owned credential acquisition", () => {
  async function createCredentialSource(mode = 0o600) {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-codex-acp-credential-"));
    const runtimePrivateRoot = path.join(root, "runtime-private");
    const authSourcePath = path.join(root, "source-auth.json");
    temporaryRoots.push(root);
    await mkdir(runtimePrivateRoot, { mode: 0o700 });
    await writeFile(authSourcePath, '{"tokens":{"access_token":"private"}}\n', { mode });
    await chmod(authSourcePath, mode);
    return { authSourcePath, root, runtimePrivateRoot };
  }

  it("copies a 0600 auth source into opaque 0700 CODEX_HOME/tmp and confirms idempotent cleanup", async () => {
    const source = await createCredentialSource();
    const operation = beginCodexAcpCredentialAcquisition(source);
    const lease = await operation.lease;

    expect(lease.environment).toEqual({
      CODEX_HOME: expect.any(String),
      TMPDIR: expect.any(String),
    });
    expect(lease.environment).not.toHaveProperty("PATH");
    expect(lease.environment).not.toHaveProperty("CODEX_PATH");
    const codexHome = lease.environment.CODEX_HOME!;
    const temporaryDirectory = lease.environment.TMPDIR!;
    const privateGenerationRoot = path.dirname(codexHome);
    expect(path.dirname(temporaryDirectory)).toBe(privateGenerationRoot);
    expect(path.dirname(privateGenerationRoot)).toBe(source.runtimePrivateRoot);
    expect(path.basename(privateGenerationRoot)).not.toContain("auth");
    expect(permissionBits((await lstat(privateGenerationRoot)).mode)).toBe(0o700);
    expect(permissionBits((await lstat(codexHome)).mode)).toBe(0o700);
    expect(permissionBits((await lstat(temporaryDirectory)).mode)).toBe(0o700);
    const copiedAuth = path.join(codexHome, "auth.json");
    const policyConfig = path.join(codexHome, "config.toml");
    expect(permissionBits((await lstat(copiedAuth)).mode)).toBe(0o600);
    expect(permissionBits((await lstat(policyConfig)).mode)).toBe(0o600);
    expect(await readFile(copiedAuth, "utf8")).toContain("private");
    expect(await readFile(policyConfig, "utf8")).toBe("check_for_update_on_startup = false\n");

    await Promise.all([lease.revoke(), lease.revoke()]);
    await expect(lstat(privateGenerationRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(operation.cancelAndWait()).resolves.toEqual({ credentialCleanupConfirmed: true });
  });

  it("retains only Binding session data across credential generations", async () => {
    const source = await createCredentialSource();
    const persistentCodexHome = path.join(source.root, "binding-codex-home");
    await mkdir(persistentCodexHome, { mode: 0o700 });

    const first = beginCodexAcpCredentialAcquisition({
      ...source,
      persistentCodexHome,
    });
    const firstLease = await first.lease;
    expect(firstLease.environment.CODEX_HOME).toBe(persistentCodexHome);
    const sessionDirectory = path.join(persistentCodexHome, "sessions");
    await mkdir(sessionDirectory, { mode: 0o700 });
    const retainedSession = path.join(sessionDirectory, "retained.jsonl");
    await writeFile(retainedSession, "opaque session data\n", { mode: 0o600 });
    const firstGenerationRoot = path.dirname(firstLease.environment.TMPDIR!);
    await firstLease.revoke();

    await expect(lstat(firstGenerationRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(persistentCodexHome, "auth.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(persistentCodexHome, "config.toml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(retainedSession, "utf8")).resolves.toBe("opaque session data\n");

    const second = beginCodexAcpCredentialAcquisition({
      ...source,
      persistentCodexHome,
    });
    const secondLease = await second.lease;
    expect(secondLease.environment.CODEX_HOME).toBe(persistentCodexHome);
    expect(path.dirname(secondLease.environment.TMPDIR!)).not.toBe(firstGenerationRoot);
    await secondLease.revoke();
    await expect(readFile(retainedSession, "utf8")).resolves.toBe("opaque session data\n");
  });

  it("cancels before ownership transfer without creating a generation directory", async () => {
    const source = await createCredentialSource();
    const operation = beginCodexAcpCredentialAcquisition(source);

    await expect(operation.cancelAndWait()).resolves.toEqual({
      credentialCleanupConfirmed: true,
    });
    await expect(operation.lease).rejects.toMatchObject({
      code: "codex_acp_credential_acquisition_cancelled",
    });
    expect(await readdir(source.runtimePrivateRoot)).toEqual([]);
  });

  it("rejects symlink or non-0600 auth sources without leaving a private generation", async () => {
    const insecure = await createCredentialSource(0o644);
    await expect(beginCodexAcpCredentialAcquisition(insecure).lease).rejects.toMatchObject({
      code: "codex_acp_auth_source_permissions_invalid",
    });
    expect(await readdir(insecure.runtimePrivateRoot)).toEqual([]);

    const linked = await createCredentialSource();
    const symlinkPath = path.join(linked.root, "linked-auth.json");
    await symlink(linked.authSourcePath, symlinkPath);
    await expect(beginCodexAcpCredentialAcquisition({
      ...linked,
      authSourcePath: symlinkPath,
    }).lease).rejects.toMatchObject({
      code: "codex_acp_auth_source_symlink_forbidden",
    });
    expect(await readdir(linked.runtimePrivateRoot)).toEqual([]);
  });

  it("rejects policy environment overrides and reports cleanup failure as unconfirmed", async () => {
    const override = await createCredentialSource();
    const overrideOperation = beginCodexAcpCredentialAcquisition({
      ...override,
      environment: {
        PATH: "/attacker/bin",
        CODEX_PATH: "/attacker/codex",
        NO_BROWSER: "0",
      },
    } as Parameters<typeof beginCodexAcpCredentialAcquisition>[0]);
    await expect(overrideOperation.lease).rejects.toMatchObject({
      code: "codex_acp_credential_policy_override",
    });

    const cleanupFailure = await createCredentialSource();
    const operation = beginCodexAcpCredentialAcquisition({
      ...cleanupFailure,
      removePrivateTree: vi.fn(async () => {
        throw new Error("injected removal failure");
      }),
    });
    const lease = await operation.lease;
    await expect(lease.revoke()).rejects.toMatchObject({
      code: "codex_acp_credential_cleanup_unconfirmed",
    });
    await expect(operation.cancelAndWait()).rejects.toMatchObject({
      code: "codex_acp_credential_cleanup_unconfirmed",
    });
    await expect(lstat(path.dirname(lease.environment.CODEX_HOME!))).resolves.toBeDefined();
  });
});
