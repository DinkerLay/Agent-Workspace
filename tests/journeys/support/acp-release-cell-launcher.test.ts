import { chmod, mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAcpHostEpochRecoveryAuthority } from "../../../apps/runtime-host/src/acp-host-epoch-lease.js";
import {
  ACP_RELEASE_CELL_LAUNCHERS,
  createAcpNativeGenerationSupervisor,
  launcherDescriptor,
  validateAcpReleaseHostEnvironmentEnvelope,
  type AcpNativeHostReady,
} from "./acp-release-cell-launcher.js";

describe("provider-neutral ACP release cell launcher", () => {
  it("registers exactly the three independent ACP cells and exact evidence lanes", () => {
    expect(ACP_RELEASE_CELL_LAUNCHERS).toEqual({
      "cell_opencode-acp-task": {
        scenarioId: "scenario_opencode-acp-task",
        issuer: "opencode_acp_task_attestor",
        kind: "task",
        attestationPath: "/evidence/acp-provider",
        providerFamily: "opencode",
      },
      "cell_codex-acp-task": {
        scenarioId: "scenario_codex-acp-task",
        issuer: "codex_acp_task_attestor",
        kind: "task",
        attestationPath: "/evidence/acp-provider",
        providerFamily: "codex",
      },
      "cell_acp-meta": {
        scenarioId: "scenario_acp-meta",
        issuer: "acp_meta_attestor",
        kind: "meta",
        attestationPath: "/evidence/acp-meta",
      },
    });
    expect(() => launcherDescriptor("cell_opencode-acp-task", "scenario_codex-acp-task"))
      .toThrow("acp_release_launcher_scenario_invalid");
  });

  it("accepts only a lane-exact parsed ACP Host envelope", () => {
    expect(validateAcpReleaseHostEnvironmentEnvelope(taskEnvelope("opencode"), "opencode_acp_task_attestor"))
      .toMatchObject({ issuer: "opencode_acp_task_attestor", taskModel: "current/model" });
    expect(validateAcpReleaseHostEnvironmentEnvelope(taskEnvelope("codex"), "codex_acp_task_attestor"))
      .toMatchObject({ issuer: "codex_acp_task_attestor", taskModel: "current/model" });
    expect(validateAcpReleaseHostEnvironmentEnvelope(metaEnvelope(), "acp_meta_attestor"))
      .toMatchObject({ issuer: "acp_meta_attestor", metaProfileOptionId: "meta_profile_option_release" });

    expect(() => validateAcpReleaseHostEnvironmentEnvelope({
      ...taskEnvelope("opencode"),
      issuer: "codex_acp_task_attestor",
    }, "opencode_acp_task_attestor")).toThrow("acp_release_host_environment_invalid");
    expect(() => validateAcpReleaseHostEnvironmentEnvelope({
      ...taskEnvelope("opencode"),
      hostEnvironment: {
        ...taskEnvelope("opencode").hostEnvironment,
        AGENT_WORKSPACE_NATIVE_CONTROL_TOKEN: "caller-forged",
      },
    }, "opencode_acp_task_attestor")).toThrow("acp_release_host_environment_invalid");
    expect(() => validateAcpReleaseHostEnvironmentEnvelope({
      ...taskEnvelope("opencode"),
      hostEnvironment: {
        ...taskEnvelope("opencode").hostEnvironment,
        AGENT_WORKSPACE_CODEX_ACP_WRAPPER: "/private/cross-lane-wrapper",
      },
    }, "opencode_acp_task_attestor")).toThrow("acp_release_host_environment_invalid");
  });

  it("starts generation+1 only after the prior child confirms dedicated restart exit 75", async () => {
    const exits = [deferred<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(),
      deferred<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>()];
    const started: number[] = [];
    const terminated: number[] = [];
    const supervisor = createAcpNativeGenerationSupervisor({
      async startGeneration(generation) {
        started.push(generation);
        return Object.freeze({
          ready: ready(generation),
          exited: exits[generation - 1]!.promise,
          async terminate() { terminated.push(generation); },
        });
      },
    });

    await expect(supervisor.start()).resolves.toMatchObject({ generation: 1 });
    const generation2 = supervisor.waitForGeneration(2);
    expect(started).toEqual([1]);
    exits[0]!.resolve({ code: 75, signal: null });
    await expect(generation2).resolves.toMatchObject({ generation: 2 });
    expect(started).toEqual([1, 2]);
    await supervisor.close();
    expect(terminated).toEqual([2]);
  });

  it("fails closed on an ordinary exit and never constructs a successor generation", async () => {
    const exit = deferred<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>();
    const startGeneration = vi.fn(async (generation: number) => Object.freeze({
      ready: ready(generation),
      exited: exit.promise,
      async terminate() {},
    }));
    const supervisor = createAcpNativeGenerationSupervisor({ startGeneration });
    await supervisor.start();
    const generation2 = supervisor.waitForGeneration(2);
    exit.resolve({ code: 1, signal: null });
    await expect(generation2).rejects.toThrow("acp_release_native_host_unexpected_exit");
    expect(startGeneration).toHaveBeenCalledTimes(1);
    await supervisor.close();
  });

  it("does not treat exit 75 as lease cleanup proof and starts generation+1 only after exact lease release", async () => {
    const heldRoot = await privateRuntimeRoot("acp-launcher-held-lease-");
    const heldAuthority = createAcpHostEpochRecoveryAuthority();
    const heldExit = deferred<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>();
    const heldLease = heldAuthority.hostLeaseFactory.acquire({
      runtimeDataDirectory: heldRoot,
      newHostEpoch: "host_epoch_release_generation_1_held",
    });
    const heldSupervisor = createAcpNativeGenerationSupervisor({
      async startGeneration(generation) {
        if (generation === 1) {
          return Object.freeze({
            ready: ready(1),
            exited: heldExit.promise,
            async terminate() { heldLease.close(); },
          });
        }
        const successor = heldAuthority.hostLeaseFactory.acquire({
          runtimeDataDirectory: heldRoot,
          newHostEpoch: "host_epoch_release_generation_2_without_proof",
        });
        return Object.freeze({
          ready: ready(2),
          exited: new Promise<never>(() => undefined),
          async terminate() { successor.close(); },
        });
      },
    });
    await heldSupervisor.start();
    const rejectedSuccessor = heldSupervisor.waitForGeneration(2);
    heldExit.resolve({ code: 75, signal: null });
    await expect(rejectedSuccessor).rejects.toThrow("acp_host_epoch_lease_held");
    await heldSupervisor.close();
    await rm(heldRoot, { recursive: true, force: true });

    const releasedRoot = await privateRuntimeRoot("acp-launcher-released-lease-");
    const releasedAuthority = createAcpHostEpochRecoveryAuthority();
    const releasedExit = deferred<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>();
    const leases: Array<ReturnType<typeof releasedAuthority.hostLeaseFactory.acquire>> = [];
    const releasedSupervisor = createAcpNativeGenerationSupervisor({
      async startGeneration(generation) {
        const lease = releasedAuthority.hostLeaseFactory.acquire({
          runtimeDataDirectory: releasedRoot,
          newHostEpoch: `host_epoch_release_generation_${generation}_clean`,
        });
        leases.push(lease);
        return Object.freeze({
          ready: ready(generation),
          exited: generation === 1 ? releasedExit.promise : new Promise<never>(() => undefined),
          async terminate() { lease.close(); },
        });
      },
    });
    await releasedSupervisor.start();
    leases[0]!.close();
    const acceptedSuccessor = releasedSupervisor.waitForGeneration(2);
    releasedExit.resolve({ code: 75, signal: null });
    await expect(acceptedSuccessor).resolves.toMatchObject({ generation: 2 });
    await releasedSupervisor.close();
    await rm(releasedRoot, { recursive: true, force: true });
  });

  it("does not import the superseded direct Provider or combined native-full path", async () => {
    const source = await readFile(new URL("./acp-release-cell-launcher.ts", import.meta.url), "utf8");
    for (const forbidden of [
      "@agent-workspace/provider-opencode",
      "@agent-workspace/provider-codex",
      "cell_native-full",
      "qualified_native_",
      "native_provider_attestor",
      "native_meta_attestor",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("passes the authorized workspace only to Task Host scope, never in native argv or Meta env", async () => {
    const source = await readFile(new URL("./acp-release-cell-launcher.ts", import.meta.url), "utf8");
    expect(source).toContain('descriptor.kind === "task"');
    expect(source).toContain("AGENT_WORKSPACE_RELEASE_TASK_WORKSPACE_DIRECTORY");
    expect(source).not.toMatch(/--(?:workspace|cwd)/u);
    expect(source).not.toContain("workspaceDirectory: input.hostEnvironment.workspaceDirectory");
  });
});

function taskEnvelope(providerFamily: "opencode" | "codex") {
  const configuration = providerFamily === "opencode"
    ? {
        schemaVersion: 1,
        agents: {
          opencode: {
            kind: "opencode-acp-current-install",
            command: { env: "AGENT_WORKSPACE_OPENCODE_COMMAND" },
            executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
            authFile: { env: "AGENT_WORKSPACE_OPENCODE_AUTH" },
          },
        },
        metaProfiles: [],
      }
    : {
        schemaVersion: 1,
        agents: {
          codex: {
            kind: "codex-acp-current-install",
            wrapperCommand: { env: "AGENT_WORKSPACE_CODEX_ACP_WRAPPER" },
            codexCommand: { env: "AGENT_WORKSPACE_CODEX_COMMAND" },
            nodeCommand: { env: "AGENT_WORKSPACE_NODE_COMMAND" },
            executableSearchPath: { env: "AGENT_WORKSPACE_ACP_SEARCH_PATH" },
            authFile: { env: "AGENT_WORKSPACE_CODEX_AUTH" },
          },
        },
        metaProfiles: [],
      };
  const references = providerFamily === "opencode"
    ? {
        AGENT_WORKSPACE_OPENCODE_COMMAND: "/private/opencode",
        AGENT_WORKSPACE_ACP_SEARCH_PATH: "/private/bin:/usr/bin:/bin",
        AGENT_WORKSPACE_OPENCODE_AUTH: "/private/opencode-auth.json",
      }
    : {
        AGENT_WORKSPACE_CODEX_ACP_WRAPPER: "/private/codex-acp",
        AGENT_WORKSPACE_CODEX_COMMAND: "/private/codex",
        AGENT_WORKSPACE_NODE_COMMAND: "/private/node",
        AGENT_WORKSPACE_ACP_SEARCH_PATH: "/private/bin:/usr/bin:/bin",
        AGENT_WORKSPACE_CODEX_AUTH: "/private/codex-auth.json",
      };
  return {
    schemaVersion: 1,
    issuer: providerFamily === "opencode" ? "opencode_acp_task_attestor" : "codex_acp_task_attestor",
    workspaceDirectory: `/private/${providerFamily}-task-workspace`,
    taskModel: "current/model",
    hostEnvironment: { AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(configuration), ...references },
  } as const;
}

function metaEnvelope() {
  const configuration = {
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
          allowedTools: [],
          permissionMode: "deny",
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        },
      },
    }],
  };
  return {
    schemaVersion: 1,
    issuer: "acp_meta_attestor",
    workspaceDirectory: "/private/meta-input-workspace",
    metaProfileOptionId: "meta_profile_option_release",
    hostEnvironment: {
      AGENT_WORKSPACE_ACP_CONFIG: JSON.stringify(configuration),
      AGENT_WORKSPACE_OPENCODE_COMMAND: "/private/opencode",
      AGENT_WORKSPACE_ACP_SEARCH_PATH: "/private/bin:/usr/bin:/bin",
      AGENT_WORKSPACE_OPENCODE_AUTH: "/private/opencode-auth.json",
    },
  } as const;
}

function ready(generation: number): AcpNativeHostReady {
  return Object.freeze({
    type: "native_unified_host_ready",
    runtimeUrl: "http://127.0.0.1:41001",
    serviceUrl: "http://127.0.0.1:41002",
    healthUrl: "http://127.0.0.1:41002/health",
    hostLedgerUrl: "http://127.0.0.1:41002/evidence/commands",
    operationLedgerUrl: "http://127.0.0.1:41002/evidence/operations",
    observedLineageUrl: "http://127.0.0.1:41002/evidence/observed-lineage",
    nativeProviderLedgerUrl: "http://127.0.0.1:41002/evidence/acp-provider",
    nativeMetaLedgerUrl: "http://127.0.0.1:41002/evidence/acp-meta",
    runtimeInstanceId: "runtime_instance_release-launcher-test",
    lineageId: "session_id_native_lineage_runtime_instance_release-launcher-test",
    generation,
    issuer: "opencode_acp_task_attestor",
  });
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return Object.freeze({ promise, resolve });
}

async function privateRuntimeRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  await chmod(root, 0o700);
  return root;
}
