import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionProfileDefinitionV3,
  MetaProfileDefinitionV3,
} from "@agent-workspace/runtime-contracts";
import { createAcpProfileResolutionRegistry } from "./acp-profile-resolution.js";
import {
  beginOpenCodeAcpCredentialAcquisition,
  createOpenCodeAcpCredentialLease,
  createOpenCodeAcpCurrentInstallDescriptor,
  createOpenCodeAcpMetaCurrentInstallDescriptor,
  createOpenCodeAcpTaskExecutionPolicy,
} from "./acp-opencode-resolution.js";

const temporaryInstallRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryInstallRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function profile(): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "execution_profile_opencode_acp" as ExecutionProfileDefinitionV3["executionProfileId"],
    profileRevisionId: "profile_revision_opencode_acp",
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
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
    metaProfileId: "meta_profile_opencode_acp" as MetaProfileDefinitionV3["metaProfileId"],
    profileRevisionId: "profile_revision_opencode_meta_acp",
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
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-opencode-resolution-"));
  const bin = path.join(root, "bin");
  const artifact = path.join(root, "artifact-opencode");
  const command = path.join(bin, "opencode");
  temporaryInstallRoots.push(root);
  await mkdir(bin, { recursive: true });
  await writeFile(artifact, "future opencode artifact A", { mode: 0o700 });
  await chmod(artifact, 0o700);
  await symlink(artifact, command);
  return { artifact, bin, command, root };
}

function inspection(root: string) {
  return {
    homeDirectory: path.join(root, "inspection-home"),
    configHome: path.join(root, "inspection-config"),
    dataHome: path.join(root, "inspection-data"),
    cacheHome: path.join(root, "inspection-cache"),
    stateHome: path.join(root, "inspection-state"),
    temporaryDirectory: path.join(root, "inspection-tmp"),
  };
}

describe("OpenCode ACP current-install descriptor", () => {
  it("admits only an OpenCode Meta Profile through an independent deny-all descriptor", async () => {
    const install = await createInstall();
    const descriptor = createOpenCodeAcpMetaCurrentInstallDescriptor({
      executableSearchPath: install.bin,
      inspectionEnvironment: inspection(install.root),
      inspectVersion: async () => "2099.8.0-meta",
    });
    const artifact = await descriptor.discoverCurrent(metaProfile());

    expect(JSON.parse(artifact.environment.OPENCODE_CONFIG_CONTENT!)).toEqual({
      permission: { "*": "deny" },
    });
    expect(artifact.observedArtifactVersion).toBe("2099.8.0-meta");
    await expect(Reflect.apply(
      descriptor.discoverCurrent,
      descriptor,
      [profile()],
    )).rejects.toMatchObject({ code: "opencode_acp_meta_profile_mismatch" });
  });

  it("seals current realpath/stat/hash and accepts an unknown future version without an allowlist", async () => {
    const install = await createInstall();
    const inspectVersion = vi.fn(async () => "2099.7.0-future");
    const descriptor = createOpenCodeAcpCurrentInstallDescriptor({
      executableSearchPath: install.bin,
      inspectionEnvironment: inspection(install.root),
      executionPolicy: createOpenCodeAcpTaskExecutionPolicy({ role: "worker" }),
      inspectVersion,
    });
    const artifact = await descriptor.discoverCurrent(profile());

    expect(artifact).toMatchObject({
      canonicalLauncherPath: await realpath(install.artifact),
      launchArguments: [
        "acp",
        "--pure",
        "--hostname=127.0.0.1",
        "--port=0",
        "--no-mdns",
      ],
      observedArtifactVersion: "2099.7.0-future",
      trustState: "trusted",
      environment: {
        PATH: install.bin,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_TERMINAL_TITLE: "1",
        OPENCODE_PURE: "1",
      },
    });
    expect(artifact.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(artifact.executionConfigDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.keys(artifact.environment).sort()).toEqual([
      "LANG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_DISABLE_AUTOUPDATE",
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_PRUNE",
      "OPENCODE_DISABLE_TERMINAL_TITLE",
      "OPENCODE_PURE",
      "PATH",
    ]);
    expect(JSON.parse(artifact.environment.OPENCODE_CONFIG_CONTENT!)).toEqual({});
    expect(inspectVersion).toHaveBeenCalledWith(expect.objectContaining({
      canonicalLauncherPath: await realpath(install.artifact),
      environment: expect.objectContaining({
        HOME: inspection(install.root).homeDirectory,
        XDG_DATA_HOME: inspection(install.root).dataHome,
      }),
    }));

    const resolution = await createAcpProfileResolutionRegistry({
      createOpaqueId: () => "acp_resolution_private_opencode",
      now: () => "2026-08-12T00:00:00.000Z",
    }).resolve(profile(), descriptor);
    expect(resolution.safeObservation()).toMatchObject({
      observedArtifactVersion: "2099.7.0-future",
      trust: "trusted",
    });
    const serialized = JSON.stringify(resolution);
    expect(serialized).not.toContain(install.root);
    expect(serialized).not.toContain(artifact.artifactDigest);
  });

  it("lets the generic resolution fence detect same-path byte/version drift", async () => {
    const install = await createInstall();
    let version = "1.0.0-current";
    const descriptor = createOpenCodeAcpCurrentInstallDescriptor({
      executableSearchPath: install.bin,
      inspectionEnvironment: inspection(install.root),
      executionPolicy: createOpenCodeAcpTaskExecutionPolicy({ role: "worker" }),
      inspectVersion: async () => version,
    });
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
    await expect(resolution.assertCurrent()).resolves.toBeUndefined();

    version = "2.0.0-next";
    await writeFile(install.artifact, "future opencode artifact B", { mode: 0o700 });
    await expect(resolution.assertCurrent()).rejects.toMatchObject({
      code: "acp_current_artifact_drift",
    });
    const next = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
    expect(next.safeObservation().observedArtifactVersion).toBe("2.0.0-next");
  });

  it("rejects wrong Profile families, unsafe PATH entries, and untrusted artifacts", async () => {
    const install = await createInstall();
    const make = (overrides = {}) => createOpenCodeAcpCurrentInstallDescriptor({
      executableSearchPath: install.bin,
      inspectionEnvironment: inspection(install.root),
      executionPolicy: createOpenCodeAcpTaskExecutionPolicy({ role: "worker" }),
      inspectVersion: async () => "1.0.0",
      ...overrides,
    });
    await expect(make().discoverCurrent({ ...profile(), providerFamily: "codex" })).rejects.toMatchObject({
      code: "opencode_acp_profile_mismatch",
    });
    const taskDescriptor = make();
    await expect(Reflect.apply(
      taskDescriptor.discoverCurrent,
      taskDescriptor,
      [metaProfile()],
    )).rejects.toMatchObject({
      code: "opencode_acp_profile_mismatch",
    });
    await expect(createOpenCodeAcpCurrentInstallDescriptor({
      executableSearchPath: `relative${path.delimiter}${install.bin}`,
      inspectionEnvironment: inspection(install.root),
      executionPolicy: createOpenCodeAcpTaskExecutionPolicy({ role: "worker" }),
      inspectVersion: async () => "1.0.0",
    }).discoverCurrent(profile())).rejects.toMatchObject({
      code: "opencode_acp_search_path_invalid",
    });
    await chmod(install.artifact, 0o722);
    await expect(make().discoverCurrent(profile())).resolves.toMatchObject({
      trustState: "untrusted",
    });
  });

  it("retains provider-native defaults and admits scoped MCP only for Conductor", async () => {
    const install = await createInstall();
    const conductor = createOpenCodeAcpTaskExecutionPolicy({
      role: "conductor",
      scopedMcpServerName: "agent-workspace.conductor",
      scopedToolNames: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
    });
    expect(JSON.parse(conductor.configContent)).toEqual({});

    const make = (executionPolicy: typeof conductor) => createOpenCodeAcpCurrentInstallDescriptor({
      executableSearchPath: install.bin,
      inspectionEnvironment: inspection(install.root),
      executionPolicy,
      inspectVersion: async () => "future-current",
    });
    const conductorArtifact = await make(conductor).discoverCurrent(profile());
    const publisherArtifact = await make(createOpenCodeAcpTaskExecutionPolicy({
      role: "publisher",
    })).discoverCurrent(profile());
    expect(conductorArtifact.executionConfigDigest).not.toBe(publisherArtifact.executionConfigDigest);
    expect(() => createOpenCodeAcpTaskExecutionPolicy({
      role: "publisher",
      scopedMcpServerName: "agent-workspace.publisher",
      scopedToolNames: ["workspace.write_text"],
    })).toThrowError(expect.objectContaining({ code: "opencode_acp_role_tools_forbidden" }));
    expect(() => createOpenCodeAcpTaskExecutionPolicy({
      role: "worker",
      scopedMcpServerName: "must-not-exist",
      scopedToolNames: ["invoke_agent"],
    })).toThrowError(expect.objectContaining({ code: "opencode_acp_role_tools_forbidden" }));
  });
});

describe("OpenCode ACP private environment lease", () => {
  it("keeps XDG/auth material generation-scoped while descriptor env remains non-secret", async () => {
    const root = path.join(os.tmpdir(), "agent-workspace-opencode-private");
    const revoke = vi.fn(async () => undefined);
    const lease = createOpenCodeAcpCredentialLease({
      homeDirectory: path.join(root, "home"),
      configHome: path.join(root, "config"),
      dataHome: path.join(root, "data"),
      cacheHome: path.join(root, "cache"),
      stateHome: path.join(root, "state"),
      temporaryDirectory: path.join(root, "tmp"),
      credentialEnvironment: {
        OPENAI_API_KEY: "private-key",
        CUSTOM_PROVIDER_TOKEN: "private-token",
      },
      revoke,
    });
    expect(lease.environment).toEqual({
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      TMPDIR: path.join(root, "tmp"),
      OPENAI_API_KEY: "private-key",
      CUSTOM_PROVIDER_TOKEN: "private-token",
    });
    expect(lease.environment).not.toHaveProperty("cwd");
    await Promise.all([lease.revoke(), lease.revoke()]);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("rejects relative isolation paths and credential attempts to override Host-owned env", () => {
    const base = {
      homeDirectory: "/private/home",
      configHome: "/private/config",
      dataHome: "/private/data",
      cacheHome: "/private/cache",
      stateHome: "/private/state",
      temporaryDirectory: "/private/tmp",
      revoke: async () => undefined,
    };
    expect(() => createOpenCodeAcpCredentialLease({
      ...base,
      dataHome: "relative/data",
    })).toThrowError(expect.objectContaining({ code: "opencode_acp_private_directory_invalid" }));
    expect(() => createOpenCodeAcpCredentialLease({
      ...base,
      credentialEnvironment: { XDG_DATA_HOME: "/override" },
    })).toThrowError(expect.objectContaining({ code: "opencode_acp_credential_environment_conflict" }));
  });

  it("owns 0700 HOME/XDG/tmp, copies only a 0600 non-symlink auth file, and confirms cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-opencode-owned-"));
    temporaryInstallRoots.push(root);
    const auth = path.join(root, "auth.json");
    await writeFile(auth, "opaque-auth-fixture", { mode: 0o600 });
    await chmod(auth, 0o600);

    const operation = beginOpenCodeAcpCredentialAcquisition({
      privateRootParent: root,
      sourceAuthFile: auth,
    });
    const lease = await operation.lease;
    const privateRoot = path.dirname(lease.environment.HOME!);
    const copiedAuth = path.join(lease.environment.XDG_DATA_HOME!, "opencode", "auth.json");
    for (const directory of [
      privateRoot,
      lease.environment.HOME!,
      lease.environment.XDG_CONFIG_HOME!,
      lease.environment.XDG_DATA_HOME!,
      lease.environment.XDG_CACHE_HOME!,
      lease.environment.XDG_STATE_HOME!,
      lease.environment.TMPDIR!,
    ]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await lstat(copiedAuth)).isSymbolicLink()).toBe(false);
    expect((await stat(copiedAuth)).mode & 0o777).toBe(0o600);
    expect(await readFile(copiedAuth, "utf8")).toBe("opaque-auth-fixture");

    await lease.revoke();
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(operation.cancelAndWait()).resolves.toEqual({ credentialCleanupConfirmed: true });
  });

  it("keeps only Binding session data across process credential generations", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "agent-workspace-opencode-binding-data-")),
    );
    temporaryInstallRoots.push(root);
    const auth = path.join(root, "auth.json");
    const persistentDataHome = path.join(root, "binding-data");
    await writeFile(auth, "opaque-auth-fixture", { mode: 0o600 });
    await chmod(auth, 0o600);
    await mkdir(persistentDataHome, { mode: 0o700 });
    await chmod(persistentDataHome, 0o700);

    const firstOperation = beginOpenCodeAcpCredentialAcquisition({
      privateRootParent: root,
      sourceAuthFile: auth,
      persistentDataHome,
    });
    const firstLease = await firstOperation.lease;
    const firstGenerationRoot = path.dirname(firstLease.environment.HOME!);
    expect(firstLease.environment.XDG_DATA_HOME).toBe(persistentDataHome);
    await writeFile(path.join(persistentDataHome, "opencode.db"), "binding-session-state");
    await firstLease.revoke();
    await expect(stat(firstGenerationRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(persistentDataHome, "opencode.db"), "utf8"))
      .toBe("binding-session-state");

    const secondOperation = beginOpenCodeAcpCredentialAcquisition({
      privateRootParent: root,
      sourceAuthFile: auth,
      persistentDataHome,
    });
    const secondLease = await secondOperation.lease;
    const secondGenerationRoot = path.dirname(secondLease.environment.HOME!);
    expect(secondGenerationRoot).not.toBe(firstGenerationRoot);
    expect(secondLease.environment.XDG_DATA_HOME).toBe(persistentDataHome);
    expect(await readFile(path.join(persistentDataHome, "opencode.db"), "utf8"))
      .toBe("binding-session-state");
    await secondLease.revoke();
    await expect(stat(secondGenerationRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(persistentDataHome)).isDirectory()).toBe(true);
  });

  it("rejects unsafe auth sources and removes partial acquisition state on cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-opencode-owned-negative-"));
    temporaryInstallRoots.push(root);
    const unsafe = path.join(root, "unsafe-auth.json");
    const linked = path.join(root, "linked-auth.json");
    await writeFile(unsafe, "opaque", { mode: 0o644 });
    await chmod(unsafe, 0o644);
    await symlink(unsafe, linked);

    for (const sourceAuthFile of [unsafe, linked]) {
      const operation = beginOpenCodeAcpCredentialAcquisition({
        privateRootParent: root,
        sourceAuthFile,
      });
      await expect(operation.lease).rejects.toMatchObject({
        code: sourceAuthFile === unsafe
          ? "opencode_acp_auth_permissions_invalid"
          : "opencode_acp_auth_source_unsafe",
      });
      await expect(operation.cancelAndWait()).resolves.toEqual({ credentialCleanupConfirmed: true });
    }

    expect(() => beginOpenCodeAcpCredentialAcquisition({
      privateRootParent: root,
      sourceAuthFile: unsafe,
      credentialEnvironment: { OPENCODE_CONFIG_CONTENT: "{}" },
    })).toThrowError(expect.objectContaining({ code: "opencode_acp_credential_environment_conflict" }));
  });
});
