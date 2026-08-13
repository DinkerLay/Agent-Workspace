import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderScopedToolCall } from "@agent-workspace/provider-port";
import type { ExecutionProfileDefinitionV3 } from "@agent-workspace/runtime-contracts";
import {
  createAcpAgentProcessFactory,
  type AcpAgentIdentityVaultResolver,
  type AcpAgentChildProcess,
  type AcpAgentSpawnOptions,
} from "./acp-agent-process.js";
import { createAcpHostEpochRecoveryAuthority } from "./acp-host-epoch-lease.js";
import { createAcpPrivateBindingVaultResolver } from "./acp-private-binding-map.js";
import {
  claimAcpTargetCheckpointFactObservation,
  createAcpProviderComposition,
  type AcpTargetCheckpointFactCapability,
  type AcpProviderAvailabilityReport,
  type AcpProviderComposition,
  type AcpQualifiedBindingRuntime,
} from "./acp-provider-composition.js";
import {
  createAcpBindingPrivateStorageRegistry,
  type AcpBindingPrivateStorageRegistry,
} from "./acp-binding-private-storage.js";
import {
  createOpenCodeAcpTaskProfileAdapter,
  createOpenCodeAcpTaskReadinessRegistry,
} from "./acp-opencode-task-profile.js";
import { createProviderScopedMcpBridge } from "./provider-scoped-mcp-bridge.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const profile: ExecutionProfileDefinitionV3 = {
  executionProfileId: "execution_profile_opencode_task" as ExecutionProfileDefinitionV3["executionProfileId"],
  profileRevisionId: "profile_revision_opencode_task",
  providerFamily: "opencode",
  acpAgentKind: "native_acp",
  protocolMajor: 1,
  model: "provider/model-current",
  configIntent: {},
  requiredExtensions: [],
  capabilityPolicy: {
    requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
    allowedTools: [],
    permissionMode: "ask",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

describe("OpenCode ACP Task Profile adapter", () => {
  it("rejects missing or widened role tools before creating any child/process factory", () => {
    const createProcessFactory = vi.fn(() => {
      throw new Error("process_factory_must_not_run");
    });
    const invalid = [
      ["conductor", []],
      ["conductor", ["invoke_agent", "send_to_session", "interrupt_session", "close_session", "workspace.write_text"]],
      ["publisher", ["workspace.write_text"]],
      ["publisher", ["workspace.write_text", "send_to_session"]],
      ["publisher", ["workspace.write_text", "workspace.write_text"]],
      ["worker", ["workspace.write_text"]],
      ["reviewer", ["invoke_agent"]],
    ] as const;

    for (const [role, allowedTools] of invalid) {
      expect(() => createOpenCodeAcpTaskProfileAdapter({
        profile: {
          ...profile,
          capabilityPolicy: { ...profile.capabilityPolicy, allowedTools },
        },
        role,
        workspaceDirectory: "/private/workspace",
        bindingDisposition: "create",
        currentInstall: {
          executableSearchPath: "/bin",
          inspectionEnvironment: {
            homeDirectory: "/private/inspection/home",
            configHome: "/private/inspection/config",
            dataHome: "/private/inspection/data",
            cacheHome: "/private/inspection/cache",
            stateHome: "/private/inspection/state",
            temporaryDirectory: "/private/inspection/tmp",
          },
          inspectVersion: async () => "controlled",
        },
        credentialAcquisition: { privateRootParent: "/tmp" },
        createProcessFactory,
      })).toThrowError(expect.objectContaining({
        code: "opencode_acp_profile_role_tools_mismatch",
      }));
    }
    expect(createProcessFactory).not.toHaveBeenCalled();
  });

  it("fails closed before opening when the Workspace lease is not an exact canonical directory", async () => {
    const adapter = createOpenCodeAcpTaskProfileAdapter({
      profile,
      role: "worker",
      workspaceDirectory: "relative/workspace",
      bindingDisposition: "create",
      currentInstall: {
        executableSearchPath: "/bin",
        inspectionEnvironment: {
          homeDirectory: "/private/inspection/home",
          configHome: "/private/inspection/config",
          dataHome: "/private/inspection/data",
          cacheHome: "/private/inspection/cache",
          stateHome: "/private/inspection/state",
          temporaryDirectory: "/private/inspection/tmp",
        },
        inspectVersion: async () => "controlled",
      },
      credentialAcquisition: { privateRootParent: "/tmp" },
    });
    await expect(adapter.openBinding({ bindingHandle: "binding_handle_invalid" }))
      .rejects.toMatchObject({ code: "opencode_acp_workspace_directory_invalid" });
  });

  it("prioritizes readiness cleanup failure and poisons the adapter", async () => {
    const fixture = await createFixture();
    const releaseBinding = vi.fn(async () => {
      throw new Error("controlled_binding_cwd_cleanup_failed");
    });
    const registry = await controlledBindingCwdRegistry(fixture.privateRootParent, {
      releaseBinding,
    });
    const composition: AcpProviderComposition = Object.freeze({
      async inspectModelCatalog() {
        throw new Error("unexpected_model_catalog_inspection");
      },
      async checkReadiness() {
        throw new Error("controlled_readiness_failed");
      },
      async openBinding() {
        throw new Error("controlled_target_must_not_open");
      },
      close: vi.fn(async () => undefined),
    });
    const adapter = cleanupTestAdapter({ fixture, composition, registry });

    await expect(adapter.openBinding({ bindingHandle: "binding_handle_readiness_cleanup" }))
      .rejects.toMatchObject({ code: "opencode_acp_task_cleanup_unconfirmed" });
    expect(releaseBinding).toHaveBeenCalledTimes(1);
    await expect(adapter.openBinding({ bindingHandle: "binding_handle_readiness_cleanup" }))
      .rejects.toMatchObject({ code: "opencode_acp_task_profile_closed" });
  });

  it("does not swallow target qualification cleanup failure", async () => {
    const fixture = await createFixture();
    const closeRuntime = vi.fn(async () => {
      throw new Error("controlled_target_process_cleanup_failed");
    });
    const releaseBinding = vi.fn(async () => undefined);
    const registry = await controlledBindingCwdRegistry(fixture.privateRootParent, {
      releaseBinding,
    });
    const runtime = controlledQualifiedRuntime({
      assertQualified: vi.fn(async () => {
        throw new Error("controlled_assert_qualified_failed");
      }),
      close: closeRuntime,
    });
    const composition = controlledComposition(runtime);
    const adapter = cleanupTestAdapter({ fixture, composition, registry });

    await expect(adapter.openBinding({ bindingHandle: "binding_handle_target_cleanup" }))
      .rejects.toMatchObject({ code: "opencode_acp_task_cleanup_unconfirmed" });
    expect(closeRuntime).toHaveBeenCalledTimes(1);
    expect(releaseBinding).not.toHaveBeenCalled();
  });

  it("continues adapter close cleanup after the opened runtime fails to close", async () => {
    const fixture = await createFixture();
    const genericClose = vi.fn(async () => {
      throw new Error("controlled_generic_close_failed");
    });
    const prepareForRestart = vi.fn(async () => undefined);
    const registry = await controlledBindingCwdRegistry(fixture.privateRootParent, {
      prepareForRestart,
    });
    const runtime = controlledQualifiedRuntime({ close: genericClose });
    const composition = controlledComposition(runtime);
    const adapter = cleanupTestAdapter({ fixture, composition, registry });
    const opened = await adapter.openBinding({ bindingHandle: "binding_handle_adapter_close" });
    expect(opened.available).toBe(true);

    await expect(adapter.close()).rejects.toMatchObject({
      code: "opencode_acp_task_cleanup_unconfirmed",
    });
    expect(genericClose).toHaveBeenCalledTimes(1);
    expect(prepareForRestart).not.toHaveBeenCalled();
    expect(composition.close).not.toHaveBeenCalled();
  });

  it("proves an official-stdio generic Binding with exact cwd/policy/MCP and honest cancel settlement", async () => {
    const fixture = await createFixture();
    const spawned: Array<Readonly<{
      command: string;
      args: readonly string[];
      options: AcpAgentSpawnOptions;
      child: ControlledChild;
      peer: ControlledOpenCodePeer;
    }>> = [];
    let generation = 0;
    const processes = createAcpAgentProcessFactory({
      spawn: (command, args, options) => {
        const child = new ControlledChild();
        const peer = new ControlledOpenCodePeer(child);
        spawned.push({ command, args, options, child, peer });
        return child;
      },
      signalChild: (child, signal) => child.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
      createOpaqueId: () => `acp_generation_controlled_${++generation}`,
    });
    const checkpointCapabilities: AcpTargetCheckpointFactCapability[] = [];
    const composition = createAcpProviderComposition({
      processes,
      operationTimeoutMs: 5_000,
      createReadinessBindingHandle: () => "binding_handle_readiness_controlled",
      onTargetCheckpointFactCapability(notice) {
        checkpointCapabilities.push(notice.capability);
      },
    });
    const bridge = createProviderScopedMcpBridge({ createToken: () => "q".repeat(48) });
    const projected: unknown[] = [];
    const adapter = createOpenCodeAcpTaskProfileAdapter({
      profile: {
        ...profile,
        capabilityPolicy: {
          ...profile.capabilityPolicy,
          allowedTools: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
        },
      },
      role: "conductor",
      workspaceDirectory: fixture.workspace,
      bindingDisposition: "create",
      currentInstall: {
        executableSearchPath: fixture.bin,
        inspectionEnvironment: inspection(fixture.root),
        inspectVersion: async () => "future-controlled",
      },
      credentialAcquisition: {
        privateRootParent: fixture.privateRootParent,
        sourceAuthFile: fixture.auth,
      },
      composition,
      bridge,
      createQualificationAttemptId: () => "session_execution_attempt_qualification",
      onObservation: async (observation) => { projected.push(observation); },
    });

    const opened = await adapter.openBinding({ bindingHandle: "binding_handle_controlled" });
    if (!opened.available) {
      throw new Error(`controlled_binding_unavailable:${opened.report.unavailableReasons.join(",")}:${JSON.stringify(
        spawned.map(({ peer }) => ({ calls: peer.calls.map(({ method }) => method), tools: peer.mcpToolNames })),
      )}`);
    }
    expect(spawned).toHaveLength(2);
    const readinessNative = spawned[0]!;
    const native = spawned[1]!;
    expect(readinessNative.options.cwd).not.toBe(native.options.cwd);
    expect(readinessNative.options.cwd).not.toBe(fixture.workspace);
    await expect(stat(String(readinessNative.options.cwd))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(String(readinessNative.options.env.HOME))).rejects.toMatchObject({ code: "ENOENT" });
    expect(native.command).toBe(fixture.command);
    expect(native.args).toEqual([
      "acp",
      "--pure",
      "--hostname=127.0.0.1",
      "--port=0",
      "--no-mdns",
    ]);
    expect(native.options.cwd).not.toBe(fixture.workspace);
    expect(typeof native.options.cwd).toBe("string");
    const providerWorkingDirectory = String(native.options.cwd);
    expect((await lstat(providerWorkingDirectory)).isSymbolicLink()).toBe(false);
    expect((await stat(providerWorkingDirectory)).mode & 0o777).toBe(0o700);
    expect(await readdir(providerWorkingDirectory)).toEqual([]);
    expect(native.options.env).not.toHaveProperty("AGENT_WORKSPACE_AMBIENT_SHOULD_NOT_REACH");
    expect(native.options.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_PURE: "1",
    });
    expect(JSON.stringify(native.options.env)).not.toContain(fixture.workspace);
    expect(JSON.parse(String(native.options.env.OPENCODE_CONFIG_CONTENT))).toEqual({});
    for (const directoryKey of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "TMPDIR",
    ] as const) {
      expect((await stat(String(native.options.env[directoryKey]))).mode & 0o777).toBe(0o700);
    }
    expect((await stat(path.join(
      String(native.options.env.XDG_DATA_HOME),
      "opencode",
      "auth.json",
    ))).mode & 0o777).toBe(0o600);

    await vi.waitFor(() => expect(native.peer.promptContents).toHaveLength(1));
    expect(native.peer.newSessionParams).toHaveLength(2);
    const qualificationSession = native.peer.createdSessionIds[0]!;
    const taskSession = native.peer.createdSessionIds[1]!;
    const qualificationCwd = String(native.peer.newSessionParams[0]!.cwd);
    expect(qualificationCwd).not.toBe(providerWorkingDirectory);
    await expect(stat(qualificationCwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(native.peer.closedSessionIds).toContain(qualificationSession);
    expect(native.peer.promptCountForSession(qualificationSession)).toBe(1);
    expect(native.peer.promptCountForSession(taskSession)).toBe(0);
    expect(native.peer.newSessionParams[1]).toMatchObject({
      cwd: fixture.workspace,
      mcpServers: [{
        type: "http",
        name: expect.any(String),
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/q{48}$/u),
        headers: [],
      }],
    });
    expect(JSON.stringify(native.peer.newSessionParams[1])).toContain(fixture.workspace);
    expect(native.peer.mcpToolNames).toEqual([
      "invoke_agent",
      "send_to_session",
      "interrupt_session",
      "close_session",
    ]);
    expect(readinessNative.peer.mcpToolNames).toEqual(native.peer.mcpToolNames);
    expect(JSON.stringify(readinessNative.peer.calls)).not.toContain(fixture.workspace);
    expect(projected).toEqual([]);

    const hostTurnLease = Object.freeze({ opaque: "host_turn_lease" });
    const turnContext = Object.freeze({
      capabilityClass: "runtime_orchestration" as const,
      lease: hostTurnLease,
      handleCall: vi.fn(async (call: ProviderScopedToolCall) => Object.freeze({
        providerCallId: call.providerCallId,
        result: Object.freeze({ status: "accepted" }),
      })),
    });
    const completed = await opened.runtime.submitPrompt({
      attemptId: "session_execution_attempt_user",
      content: "controlled user turn",
      turnContext,
    });
    expect(completed).toMatchObject({
      state: "settled",
      settlement: {
        stopReason: "end_turn",
        finalCandidate: "controlled-final",
      },
    });
    if (completed.state !== "settled") throw new Error("controlled_turn_not_settled");
    expect(completed.observations.map(({ kind }) => kind)).toEqual([
      "delivery_receipt",
      "agent_message_chunk",
      "final_candidate",
      "prompt_terminal",
    ]);
    expect(JSON.stringify(projected)).not.toContain("AGENT_WORKSPACE_ACP_PROBE_OK");
    expect(native.peer.promptContents.filter((content) => content === "controlled user turn")).toHaveLength(1);
    expect(native.peer.promptCountForSession(taskSession)).toBe(1);
    expect(native.peer.promptRequests.every((request) => !Object.hasOwn(request, "tools"))).toBe(true);

    const cancelling = opened.runtime.submitPrompt({
      attemptId: "session_execution_attempt_cancel",
      content: "wait-for-cancel",
      turnContext,
    });
    await native.peer.waitForPromptCount(3);
    const interrupt = await opened.runtime.requestInterrupt({
      attemptId: "session_execution_attempt_cancel",
    });
    expect(interrupt).toEqual({ acceptance: "accepted", completion: "unknown" });
    const cancelled = await cancelling;
    expect(cancelled).toMatchObject({
      state: "settled",
      settlement: {
        stopReason: "cancelled",
        finalCandidate: "late-final-after-cancel",
      },
    });
    expect(native.peer.afterCancelMcpResult).toMatchObject({
      error: { code: -32001, message: "scoped_turn_inactive" },
    });
    expect(native.peer.cancelCount).toBe(1);
    await expect(opened.runtime.reconcilePrompt({
      attemptId: "session_execution_attempt_cancel",
    })).resolves.toBe(cancelled);
    const safe = JSON.stringify({
      report: opened.report,
      runtime: opened.runtime.safeObservation(),
      completed,
      cancelled,
    });
    expect(safe).not.toContain("raw-session-controlled");
    expect(safe).not.toContain(fixture.root);
    expect(safe).not.toContain("q".repeat(48));
    expect(safe).not.toContain("opaque-auth-controlled");

    await opened.runtime.releaseBinding();
    await adapter.close();
    await bridge.close();
    await composition.close();
    const checkpointFacts = checkpointCapabilities.map(
      claimAcpTargetCheckpointFactObservation,
    );
    expect(checkpointFacts.map(({ kind }) => kind).sort()).toEqual([
      "actual_binding_generation",
      "cancel_reconcile",
      "latest_final_terminal_pair",
      "prompt_receipt",
    ]);
    expect(new Set(checkpointFacts.map(({ processGenerationDigest }) => processGenerationDigest)).size)
      .toBe(1);
    await expect(stat(String(native.options.env.HOME))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(providerWorkingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses private Binding state while create→load→resume targets the exact Task workspace", async () => {
    const fixture = await createFixture();
    const spawned: Array<Readonly<{
      options: AcpAgentSpawnOptions;
      peer: ControlledOpenCodePeer;
    }>> = [];
    let generation = 0;
    const processes = createAcpAgentProcessFactory({
      spawn: (_command, _args, options) => {
        const child = new ControlledChild();
        const peer = new ControlledOpenCodePeer(child);
        spawned.push({ options, peer });
        return child;
      },
      signalChild: (child, signal) => child.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
      createOpaqueId: () => `acp_generation_recovery_${++generation}`,
    });
    const checkpointCapabilities: AcpTargetCheckpointFactCapability[] = [];
    const composition = createAcpProviderComposition({
      processes,
      operationTimeoutMs: 5_000,
      createReadinessBindingHandle: () => "binding_handle_readiness_recovery",
      onTargetCheckpointFactCapability(notice) {
        checkpointCapabilities.push(notice.capability);
      },
    });
    const privateStorageRegistry = createAcpBindingPrivateStorageRegistry({
      parentDirectory: fixture.privateRootParent,
    });
    const readinessRegistry = createOpenCodeAcpTaskReadinessRegistry();
    const projected: unknown[] = [];
    const createAdapter = (bindingDisposition: "create" | "load" | "resume") => (
      createOpenCodeAcpTaskProfileAdapter({
        profile,
        role: "worker",
        workspaceDirectory: fixture.workspace,
        bindingDisposition,
        currentInstall: {
          executableSearchPath: fixture.bin,
          inspectionEnvironment: inspection(fixture.root),
          inspectVersion: async () => "future-controlled",
        },
        credentialAcquisition: {
          privateRootParent: fixture.privateRootParent,
          sourceAuthFile: fixture.auth,
        },
        composition,
        bindingPrivateStorageRegistry: privateStorageRegistry,
        readinessRegistry,
        createQualificationAttemptId: () => `session_execution_attempt_${bindingDisposition}_qualification`,
        onObservation: async (observation) => { projected.push(observation); },
      })
    );

    const firstAdapter = createAdapter("create");
    const first = await firstAdapter.openBinding({ bindingHandle: "binding_handle_recovery" });
    if (!first.available) throw new Error(first.report.unavailableReasons.join(","));
    expect(spawned).toHaveLength(2);
    const generation1 = spawned[1]!;
    expect(firstAdapter.safeObservation()).toMatchObject({
      processOpenEffectCount: 2,
      qualificationPromptEffectCount: 2,
      businessPromptEffectCount: 0,
      readinessReused: false,
    });
    expect(generation1.peer.promptCountForSession(generation1.peer.createdSessionIds[1]!)).toBe(0);
    const stableCwd = String(generation1.options.cwd);
    const stableProviderData = String(generation1.options.env.XDG_DATA_HOME);
    expect(stableProviderData).not.toBe(String(spawned[0]!.options.env.XDG_DATA_HOME));
    const firstTurn = await first.runtime.submitPrompt({
      attemptId: "session_execution_attempt_generation_one",
      content: "generation-one-user-content",
    });
    expect(firstTurn.state).toBe("settled");
    expect(firstAdapter.safeObservation().businessPromptEffectCount).toBe(1);
    await firstAdapter.close();
    expect((await stat(stableCwd)).mode & 0o777).toBe(0o700);
    expect(await readdir(stableCwd)).toEqual([]);

    projected.length = 0;
    const loadAdapter = createAdapter("load");
    const loaded = await loadAdapter.openBinding({ bindingHandle: "binding_handle_recovery" });
    if (!loaded.available) throw new Error(loaded.report.unavailableReasons.join(","));
    expect(spawned).toHaveLength(3);
    const generation2 = spawned[2]!;
    expect(generation2.options.cwd).toBe(stableCwd);
    expect(generation2.options.env.XDG_DATA_HOME).toBe(stableProviderData);
    expect(generation2.peer.loadSessionParams).toHaveLength(1);
    expect(generation2.peer.loadSessionParams[0]).toMatchObject({ cwd: fixture.workspace });
    expect(generation2.peer.promptCountForSession(
      String(generation2.peer.loadSessionParams[0]!.sessionId),
    )).toBe(0);
    expect(loadAdapter.safeObservation()).toMatchObject({
      processOpenEffectCount: 1,
      qualificationPromptEffectCount: 1,
      businessPromptEffectCount: 0,
      readinessReused: true,
    });
    expect(generation2.peer.promptContents).not.toContain("generation-one-user-content");
    expect(projected).toEqual([]);
    await loadAdapter.close();

    const resumeAdapter = createAdapter("resume");
    const resumed = await resumeAdapter.openBinding({ bindingHandle: "binding_handle_recovery" });
    if (!resumed.available) throw new Error(resumed.report.unavailableReasons.join(","));
    expect(spawned).toHaveLength(4);
    const generation3 = spawned[3]!;
    expect(generation3.options.cwd).toBe(stableCwd);
    expect(generation3.options.env.XDG_DATA_HOME).toBe(stableProviderData);
    expect(generation3.peer.resumeSessionParams).toHaveLength(1);
    expect(generation3.peer.resumeSessionParams[0]).toMatchObject({ cwd: fixture.workspace });
    expect(generation3.peer.promptCountForSession(
      String(generation3.peer.resumeSessionParams[0]!.sessionId),
    )).toBe(0);
    expect(resumeAdapter.safeObservation()).toMatchObject({
      processOpenEffectCount: 1,
      qualificationPromptEffectCount: 1,
      businessPromptEffectCount: 0,
      readinessReused: true,
    });
    expect(generation3.peer.promptContents).not.toContain("generation-one-user-content");
    expect(projected).toEqual([]);

    const afterRestart = await resumed.runtime.submitPrompt({
      attemptId: "session_execution_attempt_generation_three",
      content: "fresh-generation-three-content",
    });
    expect(afterRestart.state).toBe("settled");
    expect(generation3.peer.promptContents).not.toContain("generation-one-user-content");

    await resumed.runtime.releaseBinding();
    await resumeAdapter.close();
    await composition.close();
    const checkpointFacts = checkpointCapabilities.map(
      claimAcpTargetCheckpointFactObservation,
    );
    const restartFacts = checkpointFacts.filter(({ kind }) => kind === "restart_load_resume");
    expect(restartFacts).toHaveLength(1);
    expect(checkpointFacts.filter(({ processGenerationDigest }) => (
      processGenerationDigest === restartFacts[0]?.processGenerationDigest
    )).map(({ kind }) => kind).sort()).toEqual([
      "actual_binding_generation",
      "latest_final_terminal_pair",
      "prompt_receipt",
      "restart_load_resume",
    ]);
    await expect(stat(stableCwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers the same opaque Binding through a durable vault across fresh in-process Host compositions", async () => {
    const fixture = await createFixture();
    const runtimeDataDirectory = path.join(fixture.root, "runtime-data");
    await mkdir(runtimeDataDirectory, { mode: 0o700 });
    await chmod(runtimeDataDirectory, 0o700);
    const authority = createAcpHostEpochRecoveryAuthority();
    const hostA = authority.hostLeaseFactory.acquire({
      runtimeDataDirectory,
      newHostEpoch: "host_epoch_opencode_task_fresh_a",
    });
    let hostB: ReturnType<typeof authority.hostLeaseFactory.acquire> | undefined;
    let adapterA: ReturnType<typeof createOpenCodeAcpTaskProfileAdapter> | undefined;
    let adapterB: ReturnType<typeof createOpenCodeAcpTaskProfileAdapter> | undefined;
    const spawnedA: ControlledOpenCodePeer[] = [];
    const spawnedB: ControlledOpenCodePeer[] = [];
    let generationA = 0;
    let generationB = 0;
    const processFactory = (
      peers: ControlledOpenCodePeer[],
      nextGeneration: () => string,
    ) => (identityVaultResolver: AcpAgentIdentityVaultResolver | undefined) => {
      if (!identityVaultResolver) throw new Error("controlled_durable_resolver_missing");
      return createAcpAgentProcessFactory({
        identityVaultResolver,
        spawn: () => {
          const child = new ControlledChild();
          peers.push(new ControlledOpenCodePeer(child));
          return child;
        },
        signalChild: (child, signal) => child.kill(signal),
        terminationGraceMs: 20,
        killConfirmationMs: 20,
        createOpaqueId: nextGeneration,
      });
    };
    const createAdapter = (
      disposition: "create" | "load",
      identityVaultResolver: AcpAgentIdentityVaultResolver,
      createProcessFactory: ReturnType<typeof processFactory>,
    ) => createOpenCodeAcpTaskProfileAdapter({
      profile,
      role: "worker",
      workspaceDirectory: fixture.workspace,
      bindingDisposition: disposition,
      currentInstall: {
        executableSearchPath: fixture.bin,
        inspectionEnvironment: inspection(fixture.root),
        inspectVersion: async () => "future-controlled",
      },
      credentialAcquisition: {
        privateRootParent: fixture.privateRootParent,
        sourceAuthFile: fixture.auth,
      },
      identityVaultResolver,
      createProcessFactory,
      createQualificationAttemptId: () => `session_execution_attempt_durable_${disposition}_qualification`,
    });
    try {
      const resolverA = createAcpPrivateBindingVaultResolver({
        runtimeDataDirectory,
        authorityNamespace: "task",
        hostEpochLease: hostA,
      });
      adapterA = createAdapter(
        "create",
        resolverA,
        processFactory(spawnedA, () => `acp_generation_durable_a_${++generationA}`),
      );
      const created = await adapterA.openBinding({ bindingHandle: "binding_handle_durable_task" });
      if (!created.available) throw new Error(created.report.unavailableReasons.join(","));
      expect(spawnedA).toHaveLength(2);
      const targetA = spawnedA[1]!;
      const rawTargetSession = targetA.createdSessionIds[1]!;
      expect(targetA.promptCountForSession(rawTargetSession)).toBe(0);
      expect((await created.runtime.submitPrompt({
        attemptId: "session_execution_attempt_durable_a_business",
        content: "durable-host-a-business",
      })).state).toBe("settled");
      expect(targetA.promptCountForSession(rawTargetSession)).toBe(1);
      expect(adapterA.safeObservation()).toMatchObject({
        processOpenEffectCount: 2,
        qualificationPromptEffectCount: 2,
        businessPromptEffectCount: 1,
      });

      const confirmedDeadToken = await authority.supervisorIssuer.issueAfterConfirmedExit({
        runtimeDataDirectory,
        deadHostEpoch: hostA.hostEpoch,
        newHostEpoch: "host_epoch_opencode_task_fresh_b",
        awaitConfirmedExit: () => adapterA!.close(),
      });
      hostB = authority.hostLeaseFactory.acquire({
        runtimeDataDirectory,
        newHostEpoch: "host_epoch_opencode_task_fresh_b",
        confirmedDeadToken,
      });
      expect(hostB.recoveryReceipt()).toMatchObject({ kind: "acp_host_epoch_reclaimed" });
      const resolverB = createAcpPrivateBindingVaultResolver({
        runtimeDataDirectory,
        authorityNamespace: "task",
        hostEpochLease: hostB,
      });
      adapterB = createAdapter(
        "load",
        resolverB,
        processFactory(spawnedB, () => `acp_generation_durable_b_${++generationB}`),
      );
      const loaded = await adapterB.openBinding({ bindingHandle: "binding_handle_durable_task" });
      if (!loaded.available) throw new Error(loaded.report.unavailableReasons.join(","));
      expect(spawnedB).toHaveLength(2);
      expect(spawnedB[1]!.loadSessionParams).toEqual([
        expect.objectContaining({ sessionId: rawTargetSession }),
      ]);
      expect(spawnedB[1]!.promptContents).not.toContain("durable-host-a-business");
      expect(spawnedB[1]!.promptCountForSession(rawTargetSession)).toBe(0);
      expect((await loaded.runtime.submitPrompt({
        attemptId: "session_execution_attempt_durable_b_business",
        content: "durable-host-b-business",
      })).state).toBe("settled");
      expect(spawnedB[1]!.promptCountForSession(rawTargetSession)).toBe(1);
      expect(adapterB.safeObservation()).toMatchObject({
        processOpenEffectCount: 2,
        qualificationPromptEffectCount: 2,
        businessPromptEffectCount: 1,
      });
      await loaded.runtime.releaseBinding();
      await adapterB.close();
      adapterB = undefined;
    } finally {
      await adapterB?.close().catch(() => undefined);
      await adapterA?.close().catch(() => undefined);
      hostB?.close();
      hostA.close();
    }
    expect(await readdir(fixture.privateRootParent)).toEqual([]);
  });

  it("keeps a mid-prompt crash reconciling and never resends the ambiguous prompt", async () => {
    const fixture = await createFixture();
    const spawned: Array<Readonly<{
      options: AcpAgentSpawnOptions;
      peer: ControlledOpenCodePeer;
    }>> = [];
    let generation = 0;
    const processes = createAcpAgentProcessFactory({
      spawn: (_command, _args, options) => {
        const child = new ControlledChild();
        const peer = new ControlledOpenCodePeer(child);
        spawned.push({ options, peer });
        return child;
      },
      signalChild: (child, signal) => child.kill(signal),
      terminationGraceMs: 20,
      killConfirmationMs: 20,
      createOpaqueId: () => `acp_generation_crash_${++generation}`,
    });
    const composition = createAcpProviderComposition({
      processes,
      operationTimeoutMs: 5_000,
      createReadinessBindingHandle: () => "binding_handle_readiness_crash",
    });
    const privateStorageRegistry = createAcpBindingPrivateStorageRegistry({
      parentDirectory: fixture.privateRootParent,
    });
    const reconciledSettlement = Object.freeze({
      bindingHandle: "binding_handle_crash",
      attemptId: "session_execution_attempt_crash",
      stopReason: "end_turn" as const,
      receiptDigest: `sha256:${"a".repeat(64)}`,
      finalCandidateGroupCount: 1,
      finalCandidate: "reconciled-final",
    });
    const reconcile = vi.fn(async () => Object.freeze({
      state: "settled" as const,
      settlement: reconciledSettlement,
      observations: Object.freeze([Object.freeze({
        kind: "final_candidate" as const,
        bindingHandle: "binding_handle_crash",
        attemptId: "session_execution_attempt_crash",
        text: "reconciled-final",
      })]),
    }));
    const projected = vi.fn(async () => undefined);
    const adapter = createOpenCodeAcpTaskProfileAdapter({
      profile,
      role: "worker",
      workspaceDirectory: fixture.workspace,
      bindingDisposition: "create",
      currentInstall: {
        executableSearchPath: fixture.bin,
        inspectionEnvironment: inspection(fixture.root),
        inspectVersion: async () => "future-controlled",
      },
      credentialAcquisition: {
        privateRootParent: fixture.privateRootParent,
        sourceAuthFile: fixture.auth,
      },
      composition,
      bindingPrivateStorageRegistry: privateStorageRegistry,
      createQualificationAttemptId: () => "session_execution_attempt_crash_qualification",
      reconciler: Object.freeze({ reconcile }),
      onObservation: projected,
    });
    const opened = await adapter.openBinding({ bindingHandle: "binding_handle_crash" });
    if (!opened.available) throw new Error(opened.report.unavailableReasons.join(","));
    const target = spawned[1]!;
    const result = await opened.runtime.submitPrompt({
      attemptId: "session_execution_attempt_crash",
      content: "crash-midprompt",
    });
    expect(result).toEqual({
      state: "reconciling",
      reason: "provider_outcome_unknown",
      resendAllowed: false,
      observations: [],
    });
    expect(target.peer.promptContents.filter((content) => content === "crash-midprompt")).toHaveLength(1);
    const replay = await opened.runtime.submitPrompt({
      attemptId: "session_execution_attempt_crash",
      content: "crash-midprompt",
    });
    expect(replay).toEqual(result);
    expect(target.peer.promptContents.filter((content) => content === "crash-midprompt")).toHaveLength(1);
    await expect(opened.runtime.submitPrompt({
      attemptId: "session_execution_attempt_after_ambiguous",
      content: "must-not-send-before-reconcile",
    })).rejects.toMatchObject({ code: "opencode_acp_task_reconciliation_required" });
    expect(target.peer.promptContents).not.toContain("must-not-send-before-reconcile");

    const reconciled = await opened.runtime.reconcilePrompt({
      attemptId: "session_execution_attempt_crash",
    });
    expect(reconciled).toMatchObject({
      state: "settled",
      settlement: { finalCandidate: "reconciled-final", finalCandidateGroupCount: 1 },
    });
    expect(await opened.runtime.reconcilePrompt({
      attemptId: "session_execution_attempt_crash",
    })).toBe(reconciled);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(projected).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: "final_candidate",
      text: "reconciled-final",
    }));
    const safe = JSON.stringify(result);
    expect(safe).not.toContain("raw-session-controlled");
    expect(safe).not.toContain(fixture.workspace);
    expect(safe).not.toContain(String(target.options.cwd));

    await adapter.close();
    await composition.close();
    const retained = await privateStorageRegistry.acquire("binding_handle_crash");
    await retained.releaseBinding();
  });
});

class ControlledChild extends EventEmitter implements AcpAgentChildProcess {
  readonly pid = 42_424;
  readonly stdin: Writable = new PassThrough();
  readonly stdout: Readable = new PassThrough();
  readonly stderr: Readable = new PassThrough();
  #closed = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!this.#closed) {
      this.#closed = true;
      queueMicrotask(() => this.emit("close", null, signal));
    }
    return true;
  }

  crash(): void {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.emit("close", 1, null));
  }
}

class ControlledOpenCodePeer {
  readonly calls: Array<Readonly<{ method: string; params: Record<string, unknown> }>> = [];
  readonly newSessionParams: Record<string, unknown>[] = [];
  readonly loadSessionParams: Record<string, unknown>[] = [];
  readonly resumeSessionParams: Record<string, unknown>[] = [];
  readonly promptRequests: Record<string, unknown>[] = [];
  readonly promptContents: string[] = [];
  readonly mcpToolNames: string[] = [];
  readonly createdSessionIds: string[] = [];
  readonly closedSessionIds: string[] = [];
  cancelCount = 0;
  afterCancelMcpResult: unknown;
  #buffer = "";
  #tail: Promise<void> = Promise.resolve();
  #mcpServersBySession = new Map<string, Array<Record<string, unknown>>>();
  #pendingCancel: (() => Promise<void>) | undefined;
  #promptWaiters: Array<() => void> = [];
  readonly #toHost: PassThrough;
  readonly #child: ControlledChild;

  constructor(child: ControlledChild) {
    this.#child = child;
    this.#toHost = child.stdout as PassThrough;
    const fromHost = child.stdin as PassThrough;
    fromHost.setEncoding("utf8");
    fromHost.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.#drain();
    });
  }

  async waitForPromptCount(count: number): Promise<void> {
    while (this.promptContents.length < count) {
      await new Promise<void>((resolve) => this.#promptWaiters.push(resolve));
    }
  }

  promptCountForSession(sessionId: string): number {
    return this.promptRequests.filter((request) => request.sessionId === sessionId).length;
  }

  #drain(): void {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "session/cancel") void this.#handle(message);
      else this.#tail = this.#tail.then(() => this.#handle(message));
    }
  }

  async #handle(message: Record<string, unknown>): Promise<void> {
    const method = String(message.method ?? "");
    const params = asRecord(message.params);
    this.calls.push({ method, params });
    try {
      const result = await this.#result(method, params);
      if (message.id !== undefined) this.#write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) {
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : "controlled_error" },
        });
      }
    }
  }

  async #result(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {} },
          mcpCapabilities: { http: true },
        },
        agentInfo: { name: "controlled-opencode-acp", version: "future-controlled" },
      };
    }
    if (method === "session/new") {
      this.newSessionParams.push(params);
      const rawSessionId = `raw-session-controlled-${this.createdSessionIds.length + 1}`;
      this.createdSessionIds.push(rawSessionId);
      this.#mcpServersBySession.set(rawSessionId, Array.isArray(params.mcpServers)
        ? params.mcpServers.map(asRecord)
        : []);
      await this.#discoverMcpTools(rawSessionId);
      return { sessionId: rawSessionId, configOptions: modelOptions() };
    }
    if (method === "session/load") {
      this.loadSessionParams.push(params);
      this.#mcpServersBySession.set(String(params.sessionId), Array.isArray(params.mcpServers)
        ? params.mcpServers.map(asRecord)
        : []);
      await this.#discoverMcpTools(String(params.sessionId));
      return { configOptions: modelOptions() };
    }
    if (method === "session/resume") {
      this.resumeSessionParams.push(params);
      this.#mcpServersBySession.set(String(params.sessionId), Array.isArray(params.mcpServers)
        ? params.mcpServers.map(asRecord)
        : []);
      await this.#discoverMcpTools(String(params.sessionId));
      return { configOptions: modelOptions() };
    }
    if (method === "session/set_config_option") return { configOptions: modelOptions() };
    if (method === "session/close") {
      this.closedSessionIds.push(String(params.sessionId));
      this.#mcpServersBySession.delete(String(params.sessionId));
      return {};
    }
    if (method === "session/cancel") {
      this.cancelCount += 1;
      await this.#pendingCancel?.();
      this.#pendingCancel = undefined;
      return {};
    }
    if (method !== "session/prompt") return {};
    this.promptRequests.push(params);
    const rawSessionId = String(params.sessionId);
    const prompt = Array.isArray(params.prompt) ? asRecord(params.prompt[0]) : {};
    const content = String(prompt.text ?? "");
    this.promptContents.push(content);
    for (const waiter of this.#promptWaiters.splice(0)) waiter();
    if (content.startsWith("ACP qualification only.")) {
      await this.#callQualificationTools(rawSessionId);
      this.#notifyFinal(rawSessionId, "AGENT_WORKSPACE_ACP_PROBE_OK", this.promptContents.length);
      return { stopReason: "end_turn" };
    }
    if (content === "wait-for-cancel") {
      return await new Promise<unknown>((resolve) => {
        this.#pendingCancel = async () => {
          const server = this.#mcpServersBySession.get(rawSessionId)?.[0];
          if (server) {
            this.afterCancelMcpResult = await mcpCall(
              String(server.url),
              "after-cancel",
              "invoke_agent",
              { agentCardId: "agent_card_after_cancel" },
            );
          }
          this.#notifyFinal(rawSessionId, "late-final-after-cancel", this.promptContents.length);
          resolve({ stopReason: "cancelled" });
        };
      });
    }
    if (content === "crash-midprompt") {
      this.#child.crash();
      return await new Promise<never>(() => undefined);
    }
    this.#notifyFinal(rawSessionId, "controlled-final", this.promptContents.length);
    return { stopReason: "end_turn" };
  }

  async #callQualificationTools(rawSessionId: string): Promise<void> {
    const server = this.#mcpServersBySession.get(rawSessionId)?.[0];
    if (!server) return;
    const calls = [
      ["invoke_agent", { agentCardId: "agent_card_probe" }],
      ["send_to_session", { sessionId: "logical_session_probe", payload: { content: "probe" } }],
      ["interrupt_session", { sessionId: "logical_session_probe" }],
      ["close_session", { sessionId: "logical_session_probe" }],
    ] as const;
    for (const [name, argumentsValue] of calls) {
      const response = await mcpCall(
        String(server.url),
        `qualification-${name}`,
        name,
        argumentsValue,
      );
      if (asRecord(response).error) throw new Error("controlled_mcp_call_failed");
    }
  }

  async #discoverMcpTools(rawSessionId: string): Promise<void> {
    const server = this.#mcpServersBySession.get(rawSessionId)?.[0];
    if (!server) return;
    const response = await mcpList(String(server.url), `discovery-${rawSessionId}`);
    const result = asRecord(response.result);
    const tools = Array.isArray(result.tools) ? result.tools.map(asRecord) : [];
    for (const tool of tools) {
      const name = String(tool.name);
      if (!this.mcpToolNames.includes(name)) this.mcpToolNames.push(name);
    }
  }

  #notifyFinal(rawSessionId: string, text: string, sequence: number): void {
    this.#write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: rawSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: `raw-message-private-${sequence}`,
          content: { type: "text", text },
        },
      },
    });
  }

  #write(value: unknown): void {
    this.#toHost.write(`${JSON.stringify(value)}\n`);
  }
}

async function createFixture() {
  const created = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-opencode-task-"));
  const root = await realpath(created);
  temporaryRoots.push(root);
  const bin = path.join(root, "bin");
  const command = path.join(bin, "opencode");
  const workspace = path.join(root, "workspace");
  const privateRootParent = path.join(root, "private");
  const auth = path.join(root, "auth.json");
  await Promise.all([
    mkdir(bin, { mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
    mkdir(privateRootParent, { mode: 0o700 }),
  ]);
  await writeFile(command, "controlled-opencode-artifact", { mode: 0o700 });
  await chmod(command, 0o700);
  await writeFile(auth, "opaque-auth-controlled", { mode: 0o600 });
  await chmod(auth, 0o600);
  return { auth, bin, command, privateRootParent, root, workspace };
}

const CONTROLLED_AVAILABLE_REPORT: AcpProviderAvailabilityReport = Object.freeze({
  profileRevisionId: profile.profileRevisionId,
  providerFamily: "opencode",
  acpAgentKind: "native_acp",
  role: "worker",
  available: true,
  protocolMajor: 1,
  capabilities: Object.freeze([]),
  extensions: Object.freeze([]),
  unavailableReasons: Object.freeze([]),
  qualificationClass: "binding_behavior",
  evidenceClass: "injected_host_qualification",
});

function controlledQualifiedRuntime(overrides: Readonly<{
  assertQualified?: () => Promise<void>;
  close?: () => Promise<void>;
}> = {}): AcpQualifiedBindingRuntime {
  return Object.freeze({
    bindingHandle: "binding_handle_controlled_cleanup",
    client: Object.freeze({}),
    qualification: Object.freeze({}),
    report: CONTROLLED_AVAILABLE_REPORT,
    assertQualified: overrides.assertQualified ?? (async () => undefined),
    releaseBinding: async () => undefined,
    close: overrides.close ?? (async () => undefined),
  }) as unknown as AcpQualifiedBindingRuntime;
}

function controlledComposition(runtime: AcpQualifiedBindingRuntime): AcpProviderComposition {
  return Object.freeze({
    inspectModelCatalog: vi.fn(async () => Object.freeze({
      available: true,
      modelCatalog: Object.freeze([]),
      unavailableReasons: Object.freeze([]),
    })),
    checkReadiness: vi.fn(async () => CONTROLLED_AVAILABLE_REPORT),
    openBinding: vi.fn(async () => Object.freeze({
      available: true as const,
      runtime,
      report: CONTROLLED_AVAILABLE_REPORT,
    })),
    close: vi.fn(async () => undefined),
  });
}

async function controlledBindingCwdRegistry(
  parent: string,
  overrides: Readonly<{
    assertProcessWorkingDirectoryEmpty?: () => Promise<true>;
    prepareForRestart?: () => Promise<void>;
    releaseBinding?: () => Promise<void>;
  }> = {},
): Promise<AcpBindingPrivateStorageRegistry> {
  const directory = path.join(parent, `controlled-cleanup-cwd-${Math.random().toString(16).slice(2)}`);
  const providerDataDirectory = `${directory}-data`;
  await mkdir(directory, { mode: 0o700 });
  await mkdir(providerDataDirectory, { mode: 0o700 });
  return Object.freeze({
    acquire: vi.fn(async () => Object.freeze({
      processWorkingDirectory: directory,
      providerDataDirectory,
      assertProcessWorkingDirectoryEmpty: overrides.assertProcessWorkingDirectoryEmpty
        ?? (async () => true as const),
      prepareForRestart: overrides.prepareForRestart ?? (async () => undefined),
      releaseBinding: overrides.releaseBinding ?? (async () => undefined),
    })),
    safeObservation: () => Object.freeze({ availability: "active" as const, bindingCount: 1 }),
  });
}

function cleanupTestAdapter(input: Readonly<{
  fixture: Awaited<ReturnType<typeof createFixture>>;
  composition: AcpProviderComposition;
  registry: AcpBindingPrivateStorageRegistry;
}>) {
  return createOpenCodeAcpTaskProfileAdapter({
    profile,
    role: "worker",
    workspaceDirectory: input.fixture.workspace,
    bindingDisposition: "create",
    currentInstall: {
      executableSearchPath: input.fixture.bin,
      inspectionEnvironment: inspection(input.fixture.root),
      inspectVersion: async () => "controlled-cleanup",
    },
    credentialAcquisition: {
      privateRootParent: input.fixture.privateRootParent,
      sourceAuthFile: input.fixture.auth,
    },
    composition: input.composition,
    bindingPrivateStorageRegistry: input.registry,
  });
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

function modelOptions() {
  return [{
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: profile.model,
    options: [{ value: profile.model, name: "Controlled" }],
  }];
}

async function mcpCall(
  url: string,
  id: string,
  name: string,
  argumentsValue: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: argumentsValue },
    }),
  });
  return await response.json() as Record<string, unknown>;
}

async function mcpList(url: string, id: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
  });
  return await response.json() as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}
