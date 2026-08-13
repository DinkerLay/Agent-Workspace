import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import type {
  AcpV1ClientHandlers,
  AcpV1ConnectionFactory,
  InjectedAcpV1Connection,
} from "@agent-workspace/provider-acp";
import { FakeAcpV1Agent } from "@agent-workspace/provider-acp/test-support";
import {
  createAcpProfileResolutionRegistry,
  type AcpCurrentInstallDescriptor,
  type AcpDiscoveredArtifact,
} from "./acp-profile-resolution.js";
import {
  createAcpAgentProcessFactory,
  type AcpAgentChildProcess,
  type AcpAgentSpawn,
  type AcpAgentSpawnOptions,
} from "./acp-agent-process.js";
import { createAcpPrivateBindingVaultResolver } from "./acp-private-binding-map.js";
import { createAcpHostEpochRecoveryAuthority } from "./acp-host-epoch-lease.js";

function profile(): ExecutionProfileDefinitionV3 {
  return {
    executionProfileId: "execution_profile_process" as ExecutionProfileDefinitionV3["executionProfileId"],
    profileRevisionId: "profile_revision_process",
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
    protocolMajor: 1,
    model: "model-current",
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
      permissionMode: "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function artifact(label = "a"): AcpDiscoveredArtifact {
  return {
    canonicalLauncherPath: `/private/current/${label}/opencode`,
    launchArguments: ["acp"],
    observedArtifactVersion: `future-${label}`,
    artifactDigest: `sha256:${label.repeat(64)}`,
    trustState: "trusted",
    executionConfigDigest: `sha256:${label.repeat(64)}`,
    environment: { LANG: "C.UTF-8" },
  };
}

class FakeChild extends EventEmitter implements AcpAgentChildProcess {
  readonly pid = 42_424;
  readonly stdin: Writable = new PassThrough();
  readonly stdout: Readable = new PassThrough();
  readonly stderr: Readable = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  confirmOn: NodeJS.Signals | undefined;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === this.confirmOn) queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

function connectionFactory(): AcpV1ConnectionFactory {
  return (_handlers: AcpV1ClientHandlers): InjectedAcpV1Connection => ({
    initialize: async () => ({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "fake-acp" },
    }),
    newSession: async () => ({ sessionId: "raw-session-private" }),
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => undefined,
  });
}

describe("Host ACP Agent process boundary", () => {
  it("single-flights one process per Binding, uses no ambient env, and confirms TERM→KILL plus credential cleanup", async () => {
    const spawned: { child: FakeChild; command: string; args: readonly string[]; options: AcpAgentSpawnOptions }[] = [];
    const spawn: AcpAgentSpawn = (command, args, options) => {
      const child = new FakeChild();
      child.confirmOn = "SIGKILL";
      spawned.push({ child, command, args, options });
      return child;
    };
    const revoked: string[] = [];
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current",
      discoverCurrent: async () => artifact(),
    });
    const factory = createAcpAgentProcessFactory({
      spawn,
      signalChild: (child, signal) => child.kill(signal),
      terminationGraceMs: 2,
      killConfirmationMs: 20,
      createOpaqueId: (() => {
        let id = 0;
        return () => `acp_generation_private_${++id}`;
      })(),
    });
    const request = {
      bindingHandle: "binding_workspace_1",
      resolution,
      workspaceDirectory: "/private/workspace/one",
      credentialLease: {
        environment: { ACP_TOKEN: "raw-credential-secret" },
        revoke: async () => { revoked.push("binding_workspace_1"); },
      },
      createConnection: () => connectionFactory(),
    } as const;

    const [lease, replay] = await Promise.all([factory.open(request), factory.open(request)]);
    expect(replay).toBe(lease);
    const other = await factory.open({
      ...request,
      bindingHandle: "binding_workspace_2",
      credentialLease: {
        environment: { ACP_TOKEN: "other-secret" },
        revoke: async () => { revoked.push("binding_workspace_2"); },
      },
    });
    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toMatchObject({
      command: "/private/current/a/opencode",
      args: ["acp"],
      options: {
        cwd: "/private/workspace/one",
        env: { LANG: "C.UTF-8", ACP_TOKEN: "raw-credential-secret" },
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    });
    expect(spawned[0].options.env).not.toHaveProperty("PATH");

    (spawned[0].child.stderr as PassThrough).write("raw-session-private /private/workspace/one");
    expect(JSON.stringify(lease.safeObservation())).not.toContain("raw-session-private");
    expect(JSON.stringify(lease.safeObservation())).not.toContain("/private/");

    await lease.close();
    await other.close();
    expect(spawned[0].child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawned[1].child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(revoked.sort()).toEqual(["binding_workspace_1", "binding_workspace_2"]);
    expect(lease.generation.isActive()).toBe(false);
    await factory.close();
  });

  it("fails unavailable when exit or credential cleanup cannot be confirmed", async () => {
    const child = new FakeChild();
    let revokeCalls = 0;
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current",
      discoverCurrent: async () => artifact(),
    });
    const factory = createAcpAgentProcessFactory({
      spawn: () => child,
      signalChild: (target, signal) => target.kill(signal),
      terminationGraceMs: 2,
      killConfirmationMs: 2,
    });
    const unconfirmedRequest = {
      bindingHandle: "binding_workspace_unconfirmed",
      resolution,
      workspaceDirectory: "/private/workspace/unconfirmed",
      credentialLease: {
        environment: { ACP_TOKEN: "credential-never-projected" },
        revoke: async () => { revokeCalls += 1; },
      },
      createConnection: () => connectionFactory(),
    } as const;
    const lease = await factory.open(unconfirmedRequest);

    await expect(lease.close()).rejects.toMatchObject({
      code: "acp_agent_process_exit_unconfirmed",
    });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(revokeCalls).toBe(1);
    expect(lease.safeObservation()).toMatchObject({
      availability: "unavailable",
      reason: "acp_agent_process_exit_unconfirmed",
    });
    await expect(factory.open(unconfirmedRequest)).rejects.toMatchObject({
      code: "acp_agent_process_exit_unconfirmed",
    });

    const cleanupChild = new FakeChild();
    cleanupChild.confirmOn = "SIGTERM";
    const cleanupFactory = createAcpAgentProcessFactory({
      spawn: () => cleanupChild,
      signalChild: (target, signal) => target.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const cleanupLease = await cleanupFactory.open({
      bindingHandle: "binding_workspace_cleanup",
      resolution,
      createConnection: () => connectionFactory(),
      credentialLease: {
        environment: {},
        revoke: async () => { throw new Error("raw cleanup detail"); },
      },
    });
    await expect(cleanupLease.close()).rejects.toMatchObject({
      code: "acp_agent_credential_cleanup_unconfirmed",
    });
    expect(JSON.stringify(cleanupLease.safeObservation())).not.toContain("raw cleanup detail");
  });

  it("rechecks the canonical artifact after spawn and terminates a drifted child before returning a lease", async () => {
    let current = artifact("a");
    const descriptor: AcpCurrentInstallDescriptor = {
      descriptorId: "opencode-current",
      discoverCurrent: async () => current,
    };
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), descriptor);
    const child = new FakeChild();
    child.confirmOn = "SIGTERM";
    let revoked = false;
    const factory = createAcpAgentProcessFactory({
      spawn: () => {
        current = artifact("b");
        return child;
      },
      signalChild: (target, signal) => target.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });

    await expect(factory.open({
      bindingHandle: "binding_workspace_drift",
      resolution,
      createConnection: () => connectionFactory(),
      credentialLease: {
        environment: {},
        revoke: async () => { revoked = true; },
      },
    })).rejects.toMatchObject({ code: "acp_current_artifact_drift" });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(revoked).toBe(true);
  });

  it("guards NDJSON frame size through a backpressured stream before the injected connection", async () => {
    const child = new FakeChild();
    child.confirmOn = "SIGTERM";
    let guardedOutput: Readable | undefined;
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current",
      discoverCurrent: async () => artifact(),
    });
    const factory = createAcpAgentProcessFactory({
      spawn: () => child,
      signalChild: (target, signal) => target.kill(signal),
      maxNdjsonFrameBytes: 32,
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const lease = await factory.open({
      bindingHandle: "binding_workspace_frame",
      resolution,
      createConnection: ({ output }) => {
        guardedOutput = output;
        return connectionFactory();
      },
    });
    expect(guardedOutput).not.toBe(child.stdout);

    (child.stdout as PassThrough).write(Buffer.alloc(33, 0x61));
    await expect(lease.closed).resolves.toMatchObject({ exitConfirmed: true });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(lease.safeObservation()).toMatchObject({
      availability: "unavailable",
      reason: "acp_agent_ndjson_frame_too_large",
    });
  });

  it("terminates on bounded stderr overflow and on an injected connection close", async () => {
    const children: FakeChild[] = [];
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current",
      discoverCurrent: async () => artifact(),
    });
    let closeConnection!: () => void;
    const connectionClosed = new Promise<void>((resolve) => { closeConnection = resolve; });
    const factory = createAcpAgentProcessFactory({
      spawn: () => {
        const child = new FakeChild();
        child.confirmOn = "SIGTERM";
        children.push(child);
        return child;
      },
      signalChild: (target, signal) => target.kill(signal),
      maxStderrBytes: 8,
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const stderrLease = await factory.open({
      bindingHandle: "binding_handle_stderr",
      resolution,
      createConnection: () => connectionFactory(),
    });
    (children[0].stderr as PassThrough).write("123456789");
    await expect(stderrLease.closed).resolves.toMatchObject({
      observation: { reason: "acp_agent_stderr_limit_exceeded" },
    });

    const connectionLease = await factory.open({
      bindingHandle: "binding_handle_connection",
      resolution,
      createConnection: () => (handlers) => ({
        ...connectionFactory()(handlers),
        closed: connectionClosed,
      }),
    });
    closeConnection();
    await expect(connectionLease.closed).resolves.toMatchObject({
      observation: { reason: "acp_agent_connection_closed" },
    });
    expect(children[1].signals).toEqual(["SIGTERM"]);
    await factory.close();
  });

  it("revokes bounded credentials on validation failure, rejects mismatched duplicate opens, and cleans malformed children", async () => {
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current",
      discoverCurrent: async () => artifact(),
    });
    let invalidRevokes = 0;
    const factory = createAcpAgentProcessFactory({
      spawn: () => { throw new Error("must not spawn"); },
      credentialCleanupTimeoutMs: 5,
    });
    await expect(factory.open({
      bindingHandle: "binding_handle_invalid",
      resolution,
      workspaceDirectory: "relative/workspace",
      credentialLease: {
        environment: { ACP_TOKEN: "secret" },
        revoke: async () => { invalidRevokes += 1; },
      },
      createConnection: () => connectionFactory(),
    })).rejects.toMatchObject({ code: "acp_agent_working_directory_invalid" });
    expect(invalidRevokes).toBe(1);

    await expect(factory.open({
      bindingHandle: "binding_handle_hung_cleanup",
      resolution,
      workspaceDirectory: "relative/workspace",
      credentialLease: {
        environment: {},
        revoke: () => new Promise<void>(() => undefined),
      },
      createConnection: () => connectionFactory(),
    })).rejects.toMatchObject({ code: "acp_agent_credential_cleanup_unconfirmed" });

    const malformed = new FakeChild();
    malformed.confirmOn = "SIGTERM";
    Object.defineProperty(malformed, "stdout", { value: undefined });
    let malformedRevoked = false;
    const malformedFactory = createAcpAgentProcessFactory({
      spawn: () => malformed,
      signalChild: (target, signal) => target.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    await expect(malformedFactory.open({
      bindingHandle: "binding_handle_malformed",
      resolution,
      credentialLease: {
        environment: {},
        revoke: async () => { malformedRevoked = true; },
      },
      createConnection: () => connectionFactory(),
    })).rejects.toMatchObject({ code: "acp_agent_child_invalid" });
    expect(malformed.signals).toEqual(["SIGTERM"]);
    expect(malformedRevoked).toBe(true);

    const activeChild = new FakeChild();
    activeChild.confirmOn = "SIGTERM";
    const duplicateFactory = createAcpAgentProcessFactory({
      spawn: () => activeChild,
      signalChild: (target, signal) => target.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const activeRequest = {
      bindingHandle: "binding_handle_duplicate",
      resolution,
      createConnection: () => connectionFactory(),
    } as const;
    const active = await duplicateFactory.open(activeRequest);
    let unusedCredentialRevoked = false;
    await expect(duplicateFactory.open({
      ...activeRequest,
      credentialLease: {
        environment: { ACP_TOKEN: "unused" },
        revoke: async () => { unusedCredentialRevoked = true; },
      },
    })).rejects.toMatchObject({ code: "acp_agent_binding_process_request_conflict" });
    expect(unusedCredentialRevoked).toBe(true);
    await active.close();
  });

  it("shares only the Host-private vault across confirmed process generations for load recovery", async () => {
    const rawSessionId = "raw-session-host-private-recovery";
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current",
      discoverCurrent: async () => artifact(),
    });
    const children: FakeChild[] = [];
    const agents = [
      new FakeAcpV1Agent({ rawSessionId }),
      new FakeAcpV1Agent({ rawSessionId }),
    ];
    const factory = createAcpAgentProcessFactory({
      spawn: () => {
        const child = new FakeChild();
        child.confirmOn = "SIGTERM";
        children.push(child);
        return child;
      },
      signalChild: (target, signal) => target.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const firstRequest = {
      bindingHandle: "binding_handle_recovery",
      resolution,
      createConnection: () => (handlers: AcpV1ClientHandlers) => agents[0].connect(handlers),
    } as const;
    const first = await factory.open(firstRequest);
    await first.client.initialize({
      protocolMajor: 1,
      requiredCapabilities: ["session_load", "session_resume"],
      requiredExtensions: [],
    });
    await first.client.ensureBinding({
      bindingHandle: "binding_handle_recovery",
      disposition: "create",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration: { model: "fake-model", options: [] },
    });
    await expect(factory.open({
      ...firstRequest,
      createConnection: () => (handlers: AcpV1ClientHandlers) => agents[1].connect(handlers),
    })).rejects.toMatchObject({ code: "acp_agent_binding_process_request_conflict" });

    await first.close();
    const second = await factory.open({
      bindingHandle: "binding_handle_recovery",
      resolution,
      createConnection: () => (handlers: AcpV1ClientHandlers) => agents[1].connect(handlers),
    });
    await second.client.initialize({
      protocolMajor: 1,
      requiredCapabilities: ["session_load", "session_resume"],
      requiredExtensions: [],
    });
    await expect(second.client.ensureBinding({
      bindingHandle: "binding_handle_recovery",
      disposition: "load",
      workspaceDirectory: "/private/workspace/recovery",
      mcpServers: [],
      configuration: { model: "fake-model", options: [] },
    })).resolves.toMatchObject({ kind: "binding_ready", disposition: "load" });
    expect(JSON.stringify(second.safeObservation())).not.toContain(rawSessionId);
    await second.close();
  });

  it("injects one provider-neutral durable vault across fresh A/B factories after confirmed old-Host exit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-process-durable-vault-"));
    chmodSync(root, 0o700);
    const rawSessionId = "raw-session-durable-host-recovery";
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current-durable-vault",
      discoverCurrent: async () => artifact(),
    });
    const agents = [
      new FakeAcpV1Agent({ rawSessionId }),
      new FakeAcpV1Agent({ rawSessionId }),
    ];
    const spawn = () => {
      const child = new FakeChild();
      child.confirmOn = "SIGTERM";
      return child;
    };
    try {
      const authority = createAcpHostEpochRecoveryAuthority();
      const hostA = authority.hostLeaseFactory.acquire({
        runtimeDataDirectory: root,
        newHostEpoch: "host_epoch_process_composition_a",
      });
      const resolverA = createAcpPrivateBindingVaultResolver({
        runtimeDataDirectory: root,
        authorityNamespace: "task",
        hostEpochLease: hostA,
      });
      const factoryA = createAcpAgentProcessFactory({
        spawn,
        signalChild: (target, signal) => target.kill(signal),
        identityVaultResolver: resolverA,
      });
      const first = await factoryA.open({
        bindingHandle: "binding_handle_durable_composition",
        resolution,
        createConnection: () => (handlers: AcpV1ClientHandlers) => agents[0].connect(handlers),
      });
      await first.client.initialize({
        protocolMajor: 1,
        requiredCapabilities: ["session_load", "session_resume"],
        requiredExtensions: [],
      });
      await first.client.ensureBinding({
        bindingHandle: "binding_handle_durable_composition",
        disposition: "create",
        workspaceDirectory: "/private/workspace/durable-composition",
        mcpServers: [],
        configuration: { model: "fake-model", options: [] },
      });
      await first.close();
      const oldHostExit = factoryA.close();
      const confirmedDeadToken = await authority.supervisorIssuer.issueAfterConfirmedExit({
        runtimeDataDirectory: root,
        deadHostEpoch: hostA.hostEpoch,
        newHostEpoch: "host_epoch_process_composition_b",
        awaitConfirmedExit: () => oldHostExit,
      });

      const hostB = authority.hostLeaseFactory.acquire({
        runtimeDataDirectory: root,
        newHostEpoch: "host_epoch_process_composition_b",
        confirmedDeadToken,
      });
      expect(hostB.recoveryReceipt()).toEqual({
        kind: "acp_host_epoch_reclaimed",
        receiptDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      expect(() => resolverA({
        profileRevisionId: resolution.profileRevisionId,
        profileResolutionFingerprint: resolution.hostPrivateLaunchMaterial().sealFingerprint,
      }).checkout({
        bindingHandle: "binding_handle_durable_composition",
        generationId: "acp_generation_old_composition_rejected",
      })).toThrowError(expect.objectContaining({ code: "acp_host_epoch_lease_capability_invalid" }));
      const factoryB = createAcpAgentProcessFactory({
        spawn,
        signalChild: (target, signal) => target.kill(signal),
        identityVaultResolver: createAcpPrivateBindingVaultResolver({
          runtimeDataDirectory: root,
          authorityNamespace: "task",
          hostEpochLease: hostB,
        }),
      });
      const second = await factoryB.open({
        bindingHandle: "binding_handle_durable_composition",
        resolution,
        createConnection: () => (handlers: AcpV1ClientHandlers) => agents[1].connect(handlers),
      });
      await second.client.initialize({
        protocolMajor: 1,
        requiredCapabilities: ["session_load", "session_resume"],
        requiredExtensions: [],
      });
      await expect(second.client.ensureBinding({
        bindingHandle: "binding_handle_durable_composition",
        disposition: "load",
        workspaceDirectory: "/private/workspace/durable-composition",
        mcpServers: [],
        configuration: { model: "fake-model", options: [] },
      })).resolves.toMatchObject({ kind: "binding_ready", disposition: "load" });
      expect(JSON.stringify(second.safeObservation())).not.toContain(rawSessionId);
      await second.close();
      await factoryB.close();
      hostB.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels a pre-spawn open that never settles and confirms credential cleanup", async () => {
    let discoveries = 0;
    const never = new Promise<AcpDiscoveredArtifact>(() => undefined);
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current-never-settles",
      discoverCurrent: async () => {
        discoveries += 1;
        return discoveries === 1 ? artifact() : never;
      },
    });
    let spawns = 0;
    let revokes = 0;
    const factory = createAcpAgentProcessFactory({
      spawn: () => {
        spawns += 1;
        return new FakeChild();
      },
      credentialCleanupTimeoutMs: 20,
    });
    const operation = factory.beginOpen({
      bindingHandle: "binding_handle_pre_spawn_cancel",
      resolution,
      credentialLease: {
        environment: { ACP_TOKEN: "private" },
        revoke: async () => { revokes += 1; },
      },
      createConnection: () => connectionFactory(),
    });

    await expect(operation.cancelAndWait()).resolves.toEqual({
      processCleanupConfirmed: true,
      credentialCleanupConfirmed: true,
      capabilityCleanupConfirmed: true,
    });
    expect(spawns).toBe(0);
    expect(revokes).toBe(1);
    await factory.close();
  });

  it("cancels and confirms a spawned child before a late process lease settles", async () => {
    let discoveries = 0;
    let releaseFinalDiscovery!: (artifact: AcpDiscoveredArtifact) => void;
    const finalDiscovery = new Promise<AcpDiscoveredArtifact>((resolve) => {
      releaseFinalDiscovery = resolve;
    });
    const resolution = await createAcpProfileResolutionRegistry().resolve(profile(), {
      descriptorId: "opencode-current-late-lease",
      discoverCurrent: async () => {
        discoveries += 1;
        return discoveries < 3 ? artifact() : finalDiscovery;
      },
    });
    const child = new FakeChild();
    child.confirmOn = "SIGTERM";
    let revokeCalls = 0;
    const factory = createAcpAgentProcessFactory({
      spawn: () => child,
      signalChild: (target, signal) => target.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
    });
    const operation = factory.beginOpen({
      bindingHandle: "binding_handle_late_lease_cancel",
      resolution,
      credentialLease: {
        environment: {},
        revoke: async () => { revokeCalls += 1; },
      },
      createConnection: () => connectionFactory(),
    });
    while (discoveries < 3) await Promise.resolve();

    await expect(operation.cancelAndWait()).resolves.toEqual({
      processCleanupConfirmed: true,
      credentialCleanupConfirmed: true,
      capabilityCleanupConfirmed: true,
    });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(revokeCalls).toBe(1);
    releaseFinalDiscovery(artifact());
    await expect(operation.lease).rejects.toMatchObject({ code: "acp_agent_process_open_cancelled" });
    await factory.close();
  });
});
