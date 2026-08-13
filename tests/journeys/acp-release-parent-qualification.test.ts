import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpProviderAvailabilityReport } from "../../apps/runtime-host/src/acp-provider-composition.js";
import {
  AcpReleaseParentQualificationBlockedError,
  AcpReleaseParentQualificationCleanupError,
  createAcpReleaseParentProductionQualificationSeal,
  createAcpReleaseParentQualificationSealWithExecutorsForTest,
  verifyFrozenAcpReleaseParentQualificationSeal,
  type AcpReleaseParentQualificationInputAuthority,
  type AcpReleaseParentQualificationLaneExecutor,
} from "./acp-release-parent-qualification.js";
import { createAcpReleaseParentInputSeal } from "./acp-release-parent-preflight.js";
import { ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS } from "./support/acp-release-cell-launcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ACP release parent production qualification seal", () => {
  it("uses only the fixed current-install production executors and classifies pre-process unavailability as blocked", async () => {
    const fixture = await productionInputFixture();
    const inputSeal = await createAcpReleaseParentInputSeal({ environment: fixture.environment });
    const qualificationRoot = path.join(fixture.root, "qualification");
    const failure = await createAcpReleaseParentProductionQualificationSeal({
      inputSeal,
      qualificationRoot,
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpReleaseParentQualificationBlockedError);
    expect((failure as AcpReleaseParentQualificationBlockedError).code)
      .toBe("acp_release_parent_qualification_unavailable");
    expect((failure as AcpReleaseParentQualificationBlockedError).observation).toMatchObject({
      issuer: "opencode_acp_task_attestor",
      role: "conductor",
      unavailableReasons: expect.any(Array),
    });
    expect((failure as AcpReleaseParentQualificationBlockedError).observation?.unavailableReasons)
      .not.toContain("acp_task_current_resolution_vault_scope_mismatch");
    expect(await lstat(fixture.effectMarker).then(() => true, () => false)).toBe(true);
    expect(await lstat(qualificationRoot).then(() => true, () => false)).toBe(false);
  });

  it("runs exact 4+4+1 serial roles, reserves 14/13/14 effects, confirms cleanup, then mints one safe seal", async () => {
    const root = await privateRoot();
    const order: string[] = [];
    const inputs = inputAuthority(order);
    const openCode = taskExecutor("opencode_acp_task_attestor", { credential: 2, process: 2, prompt: 2 });
    const codex = taskExecutor("codex_acp_task_attestor", { credential: 1, process: 1, prompt: 1 });
    const meta = metaExecutor();

    const seal = await createAcpReleaseParentQualificationSealWithExecutorsForTest({
      inputAuthority: inputs,
      qualificationRootParent: root,
      executors: { openCode, codex, meta },
    });

    expect(order[0]).toBe("consume");
    expect(order[1]).toBe("claim");
    expect(order.filter((entry) => entry === "verify")).toHaveLength(16);
    expect(openCode.run).toHaveBeenCalledTimes(4);
    expect(codex.run).toHaveBeenCalledTimes(4);
    expect(meta.run).toHaveBeenCalledTimes(1);
    expect([...openCode.run.mock.calls, ...codex.run.mock.calls].map(([input]) => input.role)).toEqual([
      "conductor", "publisher", "worker", "reviewer",
      "conductor", "publisher", "worker", "reviewer",
    ]);
    expect(seal.safeObservation()).toEqual({
      schemaVersion: 1,
      kind: "acp_release_parent_qualification_seal",
      inputDigest: `sha256:${"a".repeat(64)}`,
      qualificationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(seal)).not.toContain(root);
    expect(JSON.stringify(seal)).not.toMatch(/(?:model|profile|credential|path|root|environment)/iu);
    await verifyFrozenAcpReleaseParentQualificationSeal(seal);
    expect(order.at(-1)).toBe("verify");
    expect(await lstat(root).then(() => true, () => false)).toBe(false);
    expect(await lstat(path.join(root, "opencode-acp-task")).then(() => true, () => false)).toBe(false);
    expect(await lstat(path.join(root, "codex-acp-task")).then(() => true, () => false)).toBe(false);
    expect(await lstat(path.join(root, "acp-meta")).then(() => true, () => false)).toBe(false);
  });

  it("fails closed on missing or mis-scoped effects and never mints a seal", async () => {
    const root = await privateRoot();
    const input = inputAuthority([]);
    const openCode = taskExecutor(
      "opencode_acp_task_attestor",
      { credential: 2, process: 2, prompt: 2 },
      async ({ reserve }) => {
        reserve({ kind: "credential_lease_acquisition", profileRevisionId: "profile_revision_bad", role: "conductor" });
        return report("profile_revision_bad", "opencode", "conductor");
      },
    );
    await expect(createAcpReleaseParentQualificationSealWithExecutorsForTest({
      inputAuthority: input,
      qualificationRootParent: root,
      executors: {
        openCode,
        codex: taskExecutor("codex_acp_task_attestor", { credential: 1, process: 1, prompt: 1 }),
        meta: metaExecutor(),
      },
    })).rejects.toThrow("acp_release_parent_qualification_effect_scope_invalid");
  });

  it("treats capability unavailability as blocked only after cleanup is confirmed", async () => {
    const root = await privateRoot();
    const unavailable = taskExecutor(
      "opencode_acp_task_attestor",
      { credential: 2, process: 2, prompt: 2 },
      async ({ profile, role }) => {
        return { ...report(profile.profileRevisionId, "opencode", role), available: false, unavailableReasons: ["capability_missing"] };
      },
    );
    const failure = await createAcpReleaseParentQualificationSealWithExecutorsForTest({
      inputAuthority: inputAuthority([]),
      qualificationRootParent: root,
      executors: {
        openCode: unavailable,
        codex: taskExecutor("codex_acp_task_attestor", { credential: 1, process: 1, prompt: 1 }),
        meta: metaExecutor(),
      },
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpReleaseParentQualificationBlockedError);
    expect((failure as AcpReleaseParentQualificationBlockedError).code)
      .toBe("acp_release_parent_qualification_unavailable");
    expect((failure as AcpReleaseParentQualificationBlockedError).observation).toEqual({
      issuer: "opencode_acp_task_attestor",
      profileRevisionId: "profile_revision_journey-opencode-acp-task-conductor-v1",
      role: "conductor",
      unavailableReasons: ["capability_missing"],
    });
  });

  it("classifies an unavailable report with ambiguous native cleanup as a safety failure", async () => {
    const root = await privateRoot();
    const unavailable = taskExecutor(
      "opencode_acp_task_attestor",
      { credential: 2, process: 2, prompt: 2 },
      async ({ profile, role }) => ({
        ...report(profile.profileRevisionId, "opencode", role),
        available: false,
        unavailableReasons: [
          "acp_behavior_probe_timeout",
          "acp_probe_binding_cleanup_unconfirmed",
        ],
      }),
    );
    const failure = await createAcpReleaseParentQualificationSealWithExecutorsForTest({
      inputAuthority: inputAuthority([]),
      qualificationRootParent: root,
      executors: {
        openCode: unavailable,
        codex: taskExecutor("codex_acp_task_attestor", { credential: 1, process: 1, prompt: 1 }),
        meta: metaExecutor(),
      },
    }).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpReleaseParentQualificationCleanupError);
    expect(failure).not.toBeInstanceOf(AcpReleaseParentQualificationBlockedError);
    expect((failure as Error).message).toBe("acp_release_parent_qualification_cleanup_unconfirmed");
    expect(failure).toMatchObject({
      observation: {
        issuer: "opencode_acp_task_attestor",
        profileRevisionId: "profile_revision_journey-opencode-acp-task-conductor-v1",
        role: "conductor",
        unavailableReasons: ["acp_probe_binding_cleanup_unconfirmed"],
      },
    });
    expect(JSON.stringify(failure)).not.toContain(root);
    expect((await lstat(path.join(root, "opencode-acp-task"))).isDirectory()).toBe(true);
  });

  it("cleanup failure overrides blocked/unavailable and retains the exact lane root", async () => {
    const root = await privateRoot();
    const unavailable = taskExecutor(
      "opencode_acp_task_attestor",
      { credential: 2, process: 2, prompt: 2 },
      async ({ profile, role, reserve }) => {
        reserveExpected(reserve, profile.profileRevisionId, role, { credential: 2, process: 2, prompt: 2 });
        return { ...report(profile.profileRevisionId, "opencode", role), available: false, unavailableReasons: ["capability_missing"] };
      },
      async () => { throw new Error("cleanup failed"); },
    );
    await expect(createAcpReleaseParentQualificationSealWithExecutorsForTest({
      inputAuthority: inputAuthority([]),
      qualificationRootParent: root,
      executors: {
        openCode: unavailable,
        codex: taskExecutor("codex_acp_task_attestor", { credential: 1, process: 1, prompt: 1 }),
        meta: metaExecutor(),
      },
    })).rejects.toThrow("acp_release_parent_qualification_cleanup_unconfirmed");
    expect((await lstat(path.join(root, "opencode-acp-task"))).isDirectory()).toBe(true);
  });

  it("rejects input drift after effects as a safety failure and rejects serialized/forged seals", async () => {
    const root = await privateRoot();
    let verifications = 0;
    const authority = inputAuthority([], async () => {
      verifications += 1;
      if (verifications === 2) throw new Error("input drift");
    });
    await expect(createAcpReleaseParentQualificationSealWithExecutorsForTest({
      inputAuthority: authority,
      qualificationRootParent: root,
      executors: {
        openCode: taskExecutor("opencode_acp_task_attestor", { credential: 2, process: 2, prompt: 2 }),
        codex: taskExecutor("codex_acp_task_attestor", { credential: 1, process: 1, prompt: 1 }),
        meta: metaExecutor(),
      },
    })).rejects.toThrow("acp_release_parent_qualification_input_drift");
    await expect(verifyFrozenAcpReleaseParentQualificationSeal({
      safeObservation: () => ({
        schemaVersion: 1,
        kind: "acp_release_parent_qualification_seal",
        inputDigest: `sha256:${"a".repeat(64)}`,
        qualificationDigest: `sha256:${"b".repeat(64)}`,
      }),
      toJSON() { return this.safeObservation(); },
    })).rejects.toThrow("acp_release_parent_qualification_seal_invalid");
  });
});

function inputAuthority(
  order: string[],
  verifyEffect?: () => Promise<void>,
): AcpReleaseParentQualificationInputAuthority {
  const metaConfiguration = JSON.stringify({
    schemaVersion: 1,
    agents: {
      opencode: {
        kind: "opencode-acp-current-install",
        command: { env: "AGENT_WORKSPACE_OPENCODE_COMMAND" },
        executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
        authFile: { env: "AGENT_WORKSPACE_OPENCODE_AUTH" },
      },
    },
    metaProfiles: [{
      metaProfileOptionId: "meta_profile_option_release",
      title: "Release Meta",
      profile: {
        metaProfileId: "meta_profile_release",
        profileRevisionId: "profile_revision_release-meta",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
        protocolMajor: 1,
        role: "meta",
        model: "current/meta-model",
        configIntent: {},
        requiredExtensions: [],
        capabilityPolicy: {
          requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
          allowedTools: [], permissionMode: "deny", maxConcurrentTurns: 1, maxNativeChildren: 0,
        },
      },
    }],
  });
  const verify = vi.fn(async () => { order.push("verify"); await verifyEffect?.(); });
  return {
    consume: vi.fn(async (): ReturnType<AcpReleaseParentQualificationInputAuthority["consume"]> => {
      order.push("consume");
      return Object.freeze({ schemaVersion: 1 as const, kind: "acp_release_parent_input_seal" as const, digest: `sha256:${"a".repeat(64)}` });
    }),
    claim: vi.fn(async (): ReturnType<AcpReleaseParentQualificationInputAuthority["claim"]> => {
      order.push("claim");
      return Object.freeze([
        Object.freeze({ issuer: "opencode_acp_task_attestor" as const, taskWorkspaceDirectory: "/private/task-opencode", taskModel: "model/opencode", environment: Object.freeze({}) }),
        Object.freeze({ issuer: "codex_acp_task_attestor" as const, taskWorkspaceDirectory: "/private/task-codex", taskModel: "model/codex", environment: Object.freeze({}) }),
        Object.freeze({ issuer: "acp_meta_attestor" as const, metaProfileOptionId: "meta_profile_option_release", environment: Object.freeze({ AGENT_WORKSPACE_ACP_CONFIG: metaConfiguration }) }),
      ]);
    }),
    verify,
  };
}

function taskExecutor(
  issuer: "opencode_acp_task_attestor" | "codex_acp_task_attestor",
  effects: Readonly<{ credential: number; process: number; prompt: number }>,
  runEffect?: AcpReleaseParentQualificationLaneExecutor["run"],
  closeEffect?: AcpReleaseParentQualificationLaneExecutor["close"],
) {
  const family = issuer === "opencode_acp_task_attestor" ? "opencode" : "codex";
  return {
    issuer: issuer as typeof issuer,
    run: vi.fn(runEffect ?? (async ({ profile, role, reserve }) => {
      reserveExpected(reserve, profile.profileRevisionId, role, effects);
      return report(profile.profileRevisionId, family, role);
    })),
    close: vi.fn(closeEffect ?? (async () => undefined)),
  };
}

function metaExecutor() {
  return {
    issuer: "acp_meta_attestor" as const,
    run: vi.fn(async ({ profile, reserve }) => {
      reserveExpected(reserve, profile.profileRevisionId, "meta", { credential: 2, process: 2, prompt: 1 });
      return report(profile.profileRevisionId, profile.providerFamily, "meta");
    }),
    close: vi.fn(async () => undefined),
  };
}

function reserveExpected(
  reserve: Parameters<AcpReleaseParentQualificationLaneExecutor["run"]>[0]["reserve"],
  profileRevisionId: string,
  role: "conductor" | "publisher" | "worker" | "reviewer" | "meta",
  effects: Readonly<{ credential: number; process: number; prompt: number }>,
): void {
  for (let index = 0; index < effects.credential; index += 1) {
    reserve({ kind: "credential_lease_acquisition", profileRevisionId, role });
  }
  for (let index = 0; index < effects.process; index += 1) {
    reserve({ kind: "process_generation_start", profileRevisionId, role });
  }
  for (let index = 0; index < effects.prompt; index += 1) {
    reserve({ kind: "model_prompt_submission", profileRevisionId, role });
  }
}

function report(
  profileRevisionId: string,
  providerFamily: "opencode" | "codex",
  role: "conductor" | "publisher" | "worker" | "reviewer" | "meta",
): AcpProviderAvailabilityReport {
  return {
    profileRevisionId,
    providerFamily,
    acpAgentKind: providerFamily === "opencode" ? "native_acp" : "codex_acp",
    role,
    available: true,
    protocolMajor: 1,
    agent: { name: `${providerFamily}-acp`, version: "current" },
    capabilities: ["session_new", "session_prompt"],
    extensions: [],
    capabilityFingerprint: `sha256:${"c".repeat(64)}`,
    probeFingerprint: `sha256:${"d".repeat(64)}`,
    unavailableReasons: [],
    qualificationClass: "binding_behavior",
    observedArtifactVersion: "current",
    evidenceClass: "injected_host_qualification",
  };
}

async function privateRoot(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "acp-parent-qualification-")));
  roots.push(parent);
  await chmod(parent, 0o700);
  return path.join(parent, "qualification");
}

async function productionInputFixture(): Promise<Readonly<{
  root: string;
  effectMarker: string;
  environment: NodeJS.ProcessEnv;
}>> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acp-parent-production-")));
  roots.push(root);
  await chmod(root, 0o700);
  const bin = path.join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const effectMarker = path.join(root, "artifact-invoked");
  for (const command of ["opencode", "codex-acp", "codex", "node", "meta-opencode"]) {
    const file = path.join(bin, command);
    await writeFile(file, `#!/bin/sh\nprintf invoked > ${JSON.stringify(effectMarker)}\n`, { mode: 0o700 });
    await chmod(file, 0o700);
  }
  const authOpenCode = path.join(root, "opencode-auth.json");
  const authCodex = path.join(root, "codex-auth.json");
  const authMeta = path.join(root, "meta-auth.json");
  for (const file of [authOpenCode, authCodex, authMeta]) await writePrivate(file, "{}\n");
  const workspaceOpenCode = await createPrivateDirectory(root, "workspace-opencode");
  const workspaceCodex = await createPrivateDirectory(root, "workspace-codex");
  const workspaceMeta = await createPrivateDirectory(root, "workspace-meta");
  const openCodeConfiguration = taskConfiguration("opencode");
  const codexConfiguration = taskConfiguration("codex");
  const metaConfiguration = metaProductionConfiguration();
  const openCodeEnvelope = path.join(root, "opencode-envelope.json");
  const codexEnvelope = path.join(root, "codex-envelope.json");
  const metaEnvelope = path.join(root, "meta-envelope.json");
  await writePrivate(openCodeEnvelope, `${JSON.stringify({
    schemaVersion: 1,
    issuer: "opencode_acp_task_attestor",
    workspaceDirectory: workspaceOpenCode,
    taskModel: "current/model",
    hostEnvironment: {
      AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(openCodeConfiguration),
      AGENT_WORKSPACE_OPENCODE_COMMAND: path.join(bin, "opencode"),
      AGENT_WORKSPACE_ACP_SEARCH_PATH: bin,
      AGENT_WORKSPACE_OPENCODE_AUTH: authOpenCode,
    },
  })}\n`);
  await writePrivate(codexEnvelope, `${JSON.stringify({
    schemaVersion: 1,
    issuer: "codex_acp_task_attestor",
    workspaceDirectory: workspaceCodex,
    taskModel: "current/model",
    hostEnvironment: {
      AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(codexConfiguration),
      AGENT_WORKSPACE_CODEX_ACP_WRAPPER: path.join(bin, "codex-acp"),
      AGENT_WORKSPACE_CODEX_COMMAND: path.join(bin, "codex"),
      AGENT_WORKSPACE_NODE_COMMAND: path.join(bin, "node"),
      AGENT_WORKSPACE_ACP_SEARCH_PATH: bin,
      AGENT_WORKSPACE_CODEX_AUTH: authCodex,
    },
  })}\n`);
  await writePrivate(metaEnvelope, `${JSON.stringify({
    schemaVersion: 1,
    issuer: "acp_meta_attestor",
    workspaceDirectory: workspaceMeta,
    metaProfileOptionId: "meta_profile_option_release",
    hostEnvironment: {
      AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(metaConfiguration),
      AGENT_WORKSPACE_OPENCODE_COMMAND: path.join(bin, "meta-opencode"),
      AGENT_WORKSPACE_ACP_SEARCH_PATH: bin,
      AGENT_WORKSPACE_OPENCODE_AUTH: authMeta,
    },
  })}\n`);
  return Object.freeze({
    root,
    effectMarker,
    environment: Object.freeze({
      [ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_opencode-acp-task"]]: openCodeEnvelope,
      [ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_codex-acp-task"]]: codexEnvelope,
      [ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_acp-meta"]]: metaEnvelope,
    }),
  });
}

function taskConfiguration(providerFamily: "opencode" | "codex"): unknown {
  return {
    schemaVersion: 1,
    agents: providerFamily === "opencode"
      ? { opencode: { kind: "opencode-acp-current-install", command: { env: "AGENT_WORKSPACE_OPENCODE_COMMAND" }, executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" }, authFile: { env: "AGENT_WORKSPACE_OPENCODE_AUTH" } } }
      : { codex: { kind: "codex-acp-current-install", wrapperCommand: { env: "AGENT_WORKSPACE_CODEX_ACP_WRAPPER" }, codexCommand: { env: "AGENT_WORKSPACE_CODEX_COMMAND" }, nodeCommand: { env: "AGENT_WORKSPACE_NODE_COMMAND" }, executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" }, authFile: { env: "AGENT_WORKSPACE_CODEX_AUTH" } } },
    metaProfiles: [],
  };
}

function metaProductionConfiguration(): unknown {
  const configuration = JSON.parse(metaConfigurationText()) as Record<string, unknown>;
  return configuration;
}

function metaConfigurationText(): string {
  return JSON.stringify({
    schemaVersion: 1,
    agents: { opencode: { kind: "opencode-acp-current-install", command: { env: "AGENT_WORKSPACE_OPENCODE_COMMAND" }, executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" }, authFile: { env: "AGENT_WORKSPACE_OPENCODE_AUTH" } } },
    metaProfiles: [{
      metaProfileOptionId: "meta_profile_option_release", title: "Release Meta",
      profile: {
        metaProfileId: "meta_profile_release", profileRevisionId: "profile_revision_release-meta",
        providerFamily: "opencode", acpAgentKind: "native_acp", protocolMajor: 1, role: "meta",
        model: "current/meta-model", configIntent: {}, requiredExtensions: [],
        capabilityPolicy: { requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"], allowedTools: [], permissionMode: "deny", maxConcurrentTurns: 1, maxNativeChildren: 0 },
      },
    }],
  });
}

async function createPrivateDirectory(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

async function writePrivate(file: string, content: string): Promise<void> {
  await writeFile(file, content, { mode: 0o600 });
  await chmod(file, 0o600);
}
