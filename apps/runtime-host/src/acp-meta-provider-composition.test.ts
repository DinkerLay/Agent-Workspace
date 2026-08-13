import { EventEmitter } from "node:events";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AcpV1ClientHandlers,
  InjectedAcpV1Connection,
} from "@agent-workspace/provider-acp";
import { createHostPrivateBindingIdentityVault } from "@agent-workspace/provider-acp/host-private";
import type { AcpMetaAgentTurnRequest } from "@agent-workspace/provider-port";
import type {
  MetaProfileDefinitionV3,
  MetaSessionId,
} from "@agent-workspace/runtime-contracts";
import type {
  AcpAgentChildProcess,
  AcpAgentSpawnOptions,
} from "./acp-agent-process.js";
import {
  createAcpMetaProviderComposition,
  type AcpMetaProfileRegistration,
} from "./acp-meta-provider-composition.js";
import {
  claimAcpTargetCheckpointFactObservation,
  claimAcpTargetLifecycleObservation,
  type AcpTargetCheckpointFactCapability,
  type AcpTargetLifecycleCapability,
} from "./acp-provider-composition.js";

const temporaryRoots: string[] = [];
const forbiddenTaskWorkspace = "/private/task-workspace-must-not-reach-meta";
const rawSessionId = "raw-meta-session-secret";
const rawMessageIds = ["raw-meta-message-first", "raw-meta-message-second"] as const;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    rm(root, { recursive: true, force: true })
  )));
});

const metaProfile: MetaProfileDefinitionV3 = {
  metaProfileId: "meta_profile_controlled",
  profileRevisionId: "profile_revision_meta-controlled",
  providerFamily: "opencode",
  acpAgentKind: "native_acp",
  protocolMajor: 1,
  role: "meta",
  model: "provider/meta-model",
  configIntent: {},
  requiredExtensions: [],
  capabilityPolicy: {
    requiredCapabilities: [],
    allowedTools: [],
    permissionMode: "deny",
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  },
};

describe("independent ACP Meta Provider composition", () => {
  it("forwards a one-shot safe lifecycle capability only after an actual MetaTurn and full cleanup", async () => {
    const fixture = await createFixture("single");
    const capabilities: AcpTargetLifecycleCapability[] = [];
    const composition = fixture.createComposition({
      onTargetLifecycleCapability(capability) {
        capabilities.push(capability);
      },
    });
    const metaSessionId = "meta_session_lifecycle" as MetaSessionId;

    await expect(composition.checkMetaProfileReadiness(
      "meta_profile_option_controlled",
    )).resolves.toMatchObject({ status: "available", reasons: [] });
    expect(capabilities).toEqual([]);

    await expect(composition.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    })).resolves.toMatchObject({ available: true });
    expect(capabilities).toEqual([]);

    const request = metaTurnRequest(metaSessionId, "meta_turn_lifecycle");
    await expect(composition.startMetaTurn(request)).resolves.toBe("accepted");
    await expect(composition.reconcileMetaTurn(request)).resolves.toMatchObject({
      state: "returned",
    });
    expect(capabilities).toEqual([]);

    await composition.closeMetaSession({ metaSessionId });
    expect(capabilities).toHaveLength(1);
    const capability = capabilities[0];
    const observation = claimAcpTargetLifecycleObservation(capability);
    expect(observation).toMatchObject({
      schemaVersion: 1,
      evidenceClass: "host_target_lifecycle_observation",
      profileRevisionId: metaProfile.profileRevisionId,
      providerFamily: metaProfile.providerFamily,
      acpAgentKind: metaProfile.acpAgentKind,
      role: "meta",
      model: metaProfile.model,
      actualPrompt: {
        receiptObserved: true,
        finalObserved: true,
        terminalObserved: true,
      },
      cleanup: {
        bindingReleaseConfirmed: true,
        processExitConfirmed: true,
        credentialCleanupConfirmed: true,
        capabilityCleanupConfirmed: true,
      },
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.actualPrompt)).toBe(true);
    expect(Object.isFrozen(observation.cleanup)).toBe(true);
    expect(() => claimAcpTargetLifecycleObservation(capability)).toThrowError(
      expect.objectContaining({ code: "acp_target_lifecycle_capability_already_claimed" }),
    );

    const serialized = JSON.stringify(observation);
    for (const forbidden of [
      fixture.privateRoot,
      forbiddenTaskWorkspace,
      "/controlled/meta-acp",
      rawSessionId,
      ...rawMessageIds,
      "META_CONTROLLED",
      "meta_turn_lifecycle",
      '"operation":"answer"',
      '"message":"controlled"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await composition.close();
  });

  it("mints all Meta facts only after cold resume, permission rejection, strict final, and cleanup", async () => {
    const fixture = await createFixture("single_then_permission");
    const vault = createHostPrivateBindingIdentityVault();
    const identityVaultResolver = () => vault;
    const metaSessionId = "meta_session_checkpoint_facts" as MetaSessionId;
    const first = fixture.createComposition({ identityVaultResolver });
    await expect(first.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    })).resolves.toMatchObject({ available: true });
    fixture.spawned[1]?.child.crash();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const capabilities: AcpTargetCheckpointFactCapability[] = [];
    const recovered = fixture.createComposition({
      identityVaultResolver,
      onTargetCheckpointFactCapability(capability) {
        capabilities.push(capability);
      },
    });
    await expect(recovered.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "resume",
    })).resolves.toMatchObject({ available: true });
    const coldRequest = metaTurnRequest(metaSessionId, "meta_turn_cold_unknown");
    await expect(recovered.reconcileMetaTurn(coldRequest)).resolves.toEqual({ state: "unknown" });
    expect(fixture.peers[3]?.promptCount).toBe(0);

    const finalRequest = metaTurnRequest(metaSessionId, "meta_turn_strict_final");
    await expect(recovered.startMetaTurn(finalRequest)).resolves.toBe("accepted");
    await expect(recovered.reconcileMetaTurn(finalRequest)).resolves.toMatchObject({
      state: "returned",
    });
    const deniedRequest = metaTurnRequest(metaSessionId, "meta_turn_permission_rejected");
    await expect(recovered.startMetaTurn(deniedRequest)).resolves.toBe("accepted");
    await expect(recovered.reconcileMetaTurn(deniedRequest)).resolves.toEqual({ state: "unknown" });
    expect(capabilities).toEqual([]);

    await recovered.closeMetaSession({ metaSessionId });
    const observations = capabilities.map(claimAcpTargetCheckpointFactObservation);
    expect(observations.map(({ kind }) => kind).sort()).toEqual([
      "cold_reconcile",
      "independent_process",
      "no_cwd",
      "no_tools",
      "no_workspace",
      "permission_rejected",
      "strict_whole_final",
    ]);
    expect(new Set(observations.map(({ processGenerationDigest }) => processGenerationDigest)).size)
      .toBe(1);
    expect(new Set(observations.map(({ profileConfigurationDigest }) => profileConfigurationDigest)).size)
      .toBe(1);
    for (const observation of observations) {
      expect(observation).toMatchObject({
        evidenceClass: "host_target_checkpoint_fact",
        profileRevisionId: metaProfile.profileRevisionId,
        role: "meta",
        model: metaProfile.model,
      });
      expect(JSON.stringify(observation)).not.toContain(fixture.privateRoot);
      expect(JSON.stringify(observation)).not.toContain(rawSessionId);
      expect(JSON.stringify(observation)).not.toContain("meta_turn_");
    }
    expect(() => claimAcpTargetCheckpointFactObservation(capabilities[0]))
      .toThrowError(expect.objectContaining({
        code: "acp_target_checkpoint_fact_capability_already_claimed",
      }));
    await recovered.close();
    await first.close().catch(() => undefined);
  });

  it("owns independent readiness caches/process identities and projects only safe readiness", async () => {
    const fixture = await createFixture("single");
    const first = fixture.createComposition();
    const second = fixture.createComposition();

    const initialOptions = first.listMetaProfileOptions();
    expect(initialOptions).toEqual([
      expect.objectContaining({
        metaProfileOptionId: "meta_profile_option_controlled",
        profile: metaProfile,
        readiness: expect.objectContaining({
          role: "meta",
          status: "checking",
          reasons: ["probe_pending"],
        }),
      }),
    ]);
    expect(first.readMetaProfileOption("meta_profile_option_controlled"))
      .toEqual(initialOptions[0]);
    expect(Object.isFrozen(initialOptions)).toBe(true);
    expect(Object.isFrozen(initialOptions[0]?.profile)).toBe(true);
    expect(Object.isFrozen(initialOptions[0]?.readiness)).toBe(true);

    const firstReadiness = await first.checkMetaProfileReadiness(
      "meta_profile_option_controlled",
    );
    const secondReadiness = await second.checkMetaProfileReadiness(
      "meta_profile_option_controlled",
    );

    expect(firstReadiness).toMatchObject({
      role: "meta",
      status: "available",
      reasons: [],
      missingCapabilities: [],
      missingExtensions: [],
      model: metaProfile.model,
    });
    expect(firstReadiness).not.toHaveProperty("observedAgent");
    expect(secondReadiness).toEqual(firstReadiness);
    expect(fixture.spawned).toHaveLength(4);
    expect(fixture.peers).toHaveLength(4);
    expect(fixture.peers.map((peer) => peer.promptCount)).toEqual([1, 0, 1, 0]);
    expect(fixture.peers[1]).toMatchObject({ loadCalls: 0, resumeCalls: 1 });
    expect(fixture.peers[3]).toMatchObject({ loadCalls: 0, resumeCalls: 1 });
    expect(fixture.peers.every((peer) => peer.rawSessionId === rawSessionId)).toBe(true);
    expect(fixture.peers.every((peer) => (
      peer.handlerKeys.join(",") === "requestPermission,sessionUpdate"
    ))).toBe(true);
    for (const peer of [fixture.peers[0], fixture.peers[2]]) {
      expect(peer?.newSessionParams).toHaveLength(1);
      expect(peer?.newSessionParams[0]).toMatchObject({ mcpServers: [] });
      expect(peer?.privateDirectoryChecks).toEqual([
        { mode: 0o700, entries: [], processMatchesWire: true },
      ]);
    }
    for (const peer of [fixture.peers[1], fixture.peers[3]]) {
      expect(peer?.newSessionParams).toHaveLength(0);
      expect(peer?.privateDirectoryChecks).toEqual([]);
    }
    for (const spawned of fixture.spawned) {
      await expect(stat(String(spawned.options.cwd))).rejects.toMatchObject({ code: "ENOENT" });
    }

    const serialized = JSON.stringify({
      options: first.listMetaProfileOptions(),
      firstReadiness,
      secondReadiness,
    });
    for (const forbidden of [
      forbiddenTaskWorkspace,
      "/controlled/meta-acp",
      rawSessionId,
      ...rawMessageIds,
      "artifactDigest",
      "capabilityFingerprint",
      "probeFingerprint",
      "resolution",
      "canonicalLauncherPath",
      "cwd",
      "metaProbe",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    await Promise.all([first.close(), second.close()]);
  });

  it.each([
    { recovery: "load" as const, expectedLoad: 1, expectedResume: 0 },
    { recovery: "resume" as const, expectedLoad: 0, expectedResume: 1 },
  ])("accepts the $recovery recovery route without requiring session/close", async ({
    recovery,
    expectedLoad,
    expectedResume,
  }) => {
    const fixture = await createFixture("single", true, {
      load: recovery === "load",
      resume: recovery === "resume",
      close: false,
    });
    const composition = fixture.createComposition();
    await expect(composition.checkMetaProfileReadiness(
      "meta_profile_option_controlled",
    )).resolves.toMatchObject({ status: "available", reasons: [] });
    expect(fixture.peers).toHaveLength(2);
    expect(fixture.peers[1]?.loadCalls).toBe(expectedLoad);
    expect(fixture.peers[1]?.resumeCalls).toBe(expectedResume);
    expect(fixture.peers[1]?.promptCount).toBe(0);
    await composition.close();
  });

  it("returns one fresh Host-only qualification report without weakening the safe readiness projection", async () => {
    const fixture = await createFixture("single");
    const composition = fixture.createComposition();
    const report = await composition.checkMetaProfileQualificationReport(
      "meta_profile_option_controlled",
    );
    expect(report).toMatchObject({
      profileRevisionId: metaProfile.profileRevisionId,
      role: "meta",
      available: true,
      qualificationClass: "binding_behavior",
      capabilityFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      probeFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(fixture.peers).toHaveLength(2);
    expect(fixture.peers.map(({ promptCount }) => promptCount)).toEqual([1, 0]);
    expect(JSON.stringify(await composition.checkMetaProfileReadiness(
      "meta_profile_option_controlled",
    ))).not.toMatch(/(?:capabilityFingerprint|probeFingerprint|cwd|rawSessionId)/u);
    await composition.close();
  });

  it("fails readiness when neither cold-recovery route is negotiated", async () => {
    const fixture = await createFixture("single", true, {
      load: false,
      resume: false,
      close: true,
    });
    const composition = fixture.createComposition();
    await expect(composition.checkMetaProfileReadiness(
      "meta_profile_option_controlled",
    )).resolves.toMatchObject({
      status: "unavailable",
      reasons: expect.arrayContaining(["acp_capability_one_of_missing"]),
    });
    expect(fixture.spawned).toHaveLength(1);
    await composition.close();
  });

  it("qualifies on a temporary recovered Binding and never prompts the target MetaSession", async () => {
    const fixture = await createFixture("single");
    const composition = fixture.createComposition();
    const metaSessionId = "meta_session_controlled" as MetaSessionId;

    const opened = await composition.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });
    expect(opened).toMatchObject({
      available: true,
      session: {
        metaSessionId,
        metaProfileOptionId: "meta_profile_option_controlled",
        profileRevisionId: metaProfile.profileRevisionId,
        status: "ready",
      },
    });
    expect(fixture.spawned).toHaveLength(2);
    expect(fixture.peers[0]?.promptCount).toBe(1);
    expect(fixture.peers[1]?.promptCount).toBe(0);
    expect(fixture.peers[1]?.newSessionParams).toHaveLength(1);

    await expect(composition.startMetaTurn(metaTurnRequest(
      "meta_session_other" as MetaSessionId,
      "meta_turn_wrong-session",
    ))).rejects.toMatchObject({ code: "acp_meta_session_not_open" });
    expect(fixture.peers[1]?.promptCount).toBe(0);

    await expect(composition.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    })).resolves.toEqual(opened);
    expect(fixture.spawned).toHaveLength(2);

    const request = metaTurnRequest(metaSessionId, "meta_turn_controlled");
    await expect(composition.startMetaTurn(request)).resolves.toBe("accepted");
    await expect(composition.reconcileMetaTurn(request)).resolves.toMatchObject({
      state: "returned",
      finalText: '{"operation":"answer","message":"controlled"}',
    });
    expect(fixture.peers[0]?.promptCount).toBe(1);
    expect(fixture.peers[1]?.promptCount).toBe(1);
    expect(fixture.peers[1]?.newSessionParams).toHaveLength(1);
    expect(fixture.peers[1]?.newSessionParams[0]).toMatchObject({ mcpServers: [] });
    expect(fixture.peers[1]?.handlerKeys).toEqual([
      "requestPermission",
      "sessionUpdate",
    ]);

    const directory = String(fixture.spawned[0]?.options.cwd);
    expect(directory).not.toBe(forbiddenTaskWorkspace);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await composition.closeMetaSession({ metaSessionId });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await composition.close();
  });

  it("injects the Host Meta identity resolver and resumes the exact Binding without session/new", async () => {
    const fixture = await createFixture("single");
    const vault = createHostPrivateBindingIdentityVault();
    const resolverScopes: Array<Readonly<{
      profileRevisionId: string;
      profileResolutionFingerprint: string;
    }>> = [];
    const identityVaultResolver = (scope: Readonly<{
      profileRevisionId: string;
      profileResolutionFingerprint: string;
    }>) => {
      resolverScopes.push(Object.freeze({ ...scope }));
      return vault;
    };
    const metaSessionId = "meta_session_resume-exact" as MetaSessionId;
    const first = fixture.createComposition({ identityVaultResolver });
    await expect(first.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    })).resolves.toMatchObject({ available: true });
    expect(fixture.peers[1]?.newSessionParams).toHaveLength(1);

    fixture.spawned[1]?.child.crash();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const recovered = fixture.createComposition({ identityVaultResolver });
    await expect(recovered.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "resume",
    })).resolves.toMatchObject({ available: true });

    expect(fixture.peers).toHaveLength(4);
    expect(fixture.peers[3]?.newSessionParams).toHaveLength(0);
    expect(fixture.peers[3]?.resumeCalls).toBe(2);
    expect(resolverScopes.length).toBeGreaterThan(0);
    expect(resolverScopes.every((scope) => (
      scope.profileRevisionId === metaProfile.profileRevisionId
      && /^sha256:[a-f0-9]{64}$/u.test(scope.profileResolutionFingerprint)
    ))).toBe(true);
    expect(JSON.stringify(resolverScopes)).not.toContain(rawSessionId);

    await recovered.close();
    await first.close().catch(() => undefined);
  });

  it("single-flights concurrent opens and fences a concurrent close", async () => {
    const fixture = await createFixture("single");
    const composition = fixture.createComposition();
    const metaSessionId = "meta_session_concurrent-open" as MetaSessionId;

    const first = composition.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });
    const replay = composition.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });
    const [opened, replayed] = await Promise.all([first, replay]);
    expect(replayed).toEqual(opened);
    expect(fixture.spawned).toHaveLength(2);

    await composition.closeMetaSession({ metaSessionId });

    const fencedSessionId = "meta_session_close-fence" as MetaSessionId;
    const opening = composition.openMetaSession({
      metaSessionId: fencedSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });
    const closing = composition.closeMetaSession({ metaSessionId: fencedSessionId });
    await Promise.allSettled([opening, closing]);
    await expect(composition.startMetaTurn(metaTurnRequest(
      fencedSessionId,
      "meta_turn_after-close-fence",
    ))).rejects.toMatchObject({ code: "acp_meta_session_not_open" });
    expect(fixture.spawned).toHaveLength(4);
    expect(fixture.spawned[3]?.child.killCalls).toBeGreaterThan(0);

    const ownerFencedSessionId = "meta_session_owner-close-fence" as MetaSessionId;
    const ownerOpening = composition.openMetaSession({
      metaSessionId: ownerFencedSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });
    const ownerClosing = composition.close();
    await Promise.allSettled([ownerOpening, ownerClosing]);
    await expect(composition.startMetaTurn(metaTurnRequest(
      ownerFencedSessionId,
      "meta_turn_after-owner-close-fence",
    ))).rejects.toMatchObject({ code: "acp_meta_session_not_open" });
    expect(fixture.spawned).toHaveLength(6);
    expect(fixture.spawned[5]?.child.killCalls).toBeGreaterThan(0);
  });

  it("bounds prompt admission and closes without waiting for a hung Turn", async () => {
    const fixture = await createFixture("hang");
    const composition = fixture.createComposition({ operationTimeoutMs: 10 });
    const metaSessionId = "meta_session_hung-turn" as MetaSessionId;
    await composition.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });

    const acceptance = composition.startMetaTurn(metaTurnRequest(
      metaSessionId,
      "meta_turn_hung",
    ));
    await expect(acceptance).resolves.toBe("unknown");
    const closeOutcome = await Promise.race([
      composition.closeMetaSession({ metaSessionId }).then(() => "closed" as const),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ]);
    expect(closeOutcome).toBe("closed");
    expect(fixture.spawned[1]?.child.killCalls).toBeGreaterThan(0);
    await composition.close();
  });

  it("fails multiple final groups and never resends an accepted or cold-reconciled Turn", async () => {
    const fixture = await createFixture("multiple");
    const composition = fixture.createComposition();
    const metaSessionId = "meta_session_multiple" as MetaSessionId;
    const request = metaTurnRequest(metaSessionId, "meta_turn_multiple");

    await expect(composition.reconcileMetaTurn(request)).resolves.toEqual({ state: "unknown" });
    expect(fixture.peers).toHaveLength(0);
    const opened = await composition.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });
    expect(opened.available).toBe(true);

    await expect(composition.startMetaTurn(request)).resolves.toBe("accepted");
    await expect(composition.reconcileMetaTurn(request)).resolves.toMatchObject({
      state: "failed",
      failureCode: "acp_meta_final_candidate_nonunique",
    });
    await expect(composition.startMetaTurn(request)).resolves.toBe("accepted");
    await expect(composition.reconcileMetaTurn(request)).resolves.toMatchObject({
      state: "failed",
      failureCode: "acp_meta_final_candidate_nonunique",
    });
    expect(fixture.peers[0]?.promptCount).toBe(1);
    expect(fixture.peers[1]?.promptCount).toBe(1);
    expect(JSON.stringify(await composition.reconcileMetaTurn(request)))
      .not.toContain(rawMessageIds[0]);

    await composition.close();
  });

  it.each(["tool", "permission", "transport_failure"] as const)(
    "fails %s activity/outcome closed and does not automatically resubmit",
    async (behavior) => {
      const fixture = await createFixture(behavior);
      const composition = fixture.createComposition();
      const metaSessionId = `meta_session_${behavior}` as MetaSessionId;
      const request = metaTurnRequest(metaSessionId, `meta_turn_${behavior}`);
      await composition.openMetaSession({
        metaSessionId,
        metaProfileOptionId: "meta_profile_option_controlled",
        disposition: "create",
      });

      await expect(composition.startMetaTurn(request)).resolves.toBe("accepted");
      await expect(composition.reconcileMetaTurn(request)).resolves.toEqual({ state: "unknown" });
      await expect(composition.startMetaTurn(request)).resolves.toBe("accepted");
      expect(fixture.peers[0]?.promptCount).toBe(1);
      expect(fixture.peers[1]?.promptCount).toBe(1);
      expect(fixture.peers[1]?.handlerKeys).toEqual([
        "requestPermission",
        "sessionUpdate",
      ]);

      await composition.close();
    },
  );

  it("rejects Task role/profile, workspace, composition and qualification injection", async () => {
    const fixture = await createFixture("single");
    expect(() => createAcpMetaProviderComposition({
      profiles: [fixture.registration],
      privateRootParent: fixture.privateRoot,
      processFactoryOptions: {
        ...fixture.processFactoryOptions,
        identityVaultResolver: undefined,
      },
    } as never)).toThrowError(expect.objectContaining({
      code: "acp_meta_process_factory_options_invalid",
    }));
    expect(() => createAcpMetaProviderComposition({
      profiles: [fixture.registration],
      privateRootParent: fixture.privateRoot,
      processFactoryOptions: fixture.processFactoryOptions,
      taskComposition: Object.freeze({}),
    } as never)).toThrowError(expect.objectContaining({ code: "acp_meta_composition_options_invalid" }));
    expect(() => createAcpMetaProviderComposition({
      profiles: [{
        ...fixture.registration,
        workspaceDirectory: forbiddenTaskWorkspace,
      }],
      privateRootParent: fixture.privateRoot,
      processFactoryOptions: fixture.processFactoryOptions,
    } as never)).toThrowError(expect.objectContaining({ code: "acp_meta_profile_registration_invalid" }));
    expect(() => createAcpMetaProviderComposition({
      profiles: [{
        ...fixture.registration,
        profile: {
          ...metaProfile,
          role: "worker",
        },
      }],
      privateRootParent: fixture.privateRoot,
      processFactoryOptions: fixture.processFactoryOptions,
    } as never)).toThrow();

    const composition = fixture.createComposition();
    await expect(composition.openMetaSession({
      metaSessionId: "meta_session_token-injection" as MetaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
      qualification: Object.freeze({ taskToken: true }),
    } as never)).rejects.toMatchObject({ code: "acp_meta_open_input_invalid" });
    expect(fixture.spawned).toHaveLength(0);
    await composition.close();
  });

  it("poisons the composition when process cleanup cannot be confirmed", async () => {
    const fixture = await createFixture("single", (index) => index === 0);
    const composition = fixture.createComposition();
    const metaSessionId = "meta_session_cleanup" as MetaSessionId;
    const opened = await composition.openMetaSession({
      metaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });
    expect(opened.available).toBe(true);

    await expect(composition.closeMetaSession({ metaSessionId })).rejects.toMatchObject({
      code: "acp_meta_cleanup_unconfirmed",
    });
    await expect(composition.checkMetaProfileReadiness(
      "meta_profile_option_controlled",
    )).resolves.toMatchObject({
      status: "unavailable",
      reasons: ["acp_meta_cleanup_unconfirmed"],
    });
    expect(fixture.spawned).toHaveLength(2);
  });

  it("retains the private cwd when rejected qualification cleanup times out", async () => {
    const fixture = await createFixture("multiple", false);
    const composition = fixture.createComposition({ operationTimeoutMs: 1 });
    const opened = await composition.openMetaSession({
      metaSessionId: "meta_session_cleanup_timeout" as MetaSessionId,
      metaProfileOptionId: "meta_profile_option_controlled",
      disposition: "create",
    });

    expect(opened).toMatchObject({
      available: false,
      readiness: {
        status: "unavailable",
        reasons: ["acp_meta_cleanup_unconfirmed"],
      },
    });
    const unknownChildCwd = String(fixture.spawned[0]?.options.cwd);
    await expect(stat(unknownChildCwd)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(composition.checkMetaProfileReadiness(
      "meta_profile_option_controlled",
    )).resolves.toMatchObject({ status: "unavailable" });
    expect(fixture.spawned).toHaveLength(1);
    await composition.close().catch(() => undefined);
  });
});

type ControlledBehavior =
  | "single"
  | "multiple"
  | "tool"
  | "permission"
  | "single_then_permission"
  | "transport_failure"
  | "hang";

async function createFixture(
  behavior: ControlledBehavior,
  killConfirmed: boolean | ((index: number) => boolean) = true,
  capabilities: Readonly<{
    readonly load: boolean;
    readonly resume: boolean;
    readonly close: boolean;
  }> = { load: true, resume: true, close: true },
): Promise<Readonly<{
  readonly privateRoot: string;
  readonly registration: AcpMetaProfileRegistration;
  readonly processFactoryOptions: NonNullable<Parameters<typeof createAcpMetaProviderComposition>[0]>["processFactoryOptions"];
  readonly spawned: Array<Readonly<{
    readonly command: string;
    readonly arguments: readonly string[];
    readonly options: AcpAgentSpawnOptions;
    readonly child: ControlledChild;
  }>>;
  readonly peers: ControlledMetaPeer[];
  createComposition(
    overrides?: Readonly<{
      operationTimeoutMs?: number;
      identityVaultResolver?: NonNullable<
        NonNullable<Parameters<typeof createAcpMetaProviderComposition>[0]>["processFactoryOptions"]
      >["identityVaultResolver"];
      onTargetLifecycleCapability?: (capability: AcpTargetLifecycleCapability) => void;
      onTargetCheckpointFactCapability?: (capability: AcpTargetCheckpointFactCapability) => void;
    }>,
  ): ReturnType<typeof createAcpMetaProviderComposition>;
}>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-meta-test-"));
  temporaryRoots.push(root);
  const privateRoot = await realpath(root);
  const spawned: Array<Readonly<{
    readonly command: string;
    readonly arguments: readonly string[];
    readonly options: AcpAgentSpawnOptions;
    readonly child: ControlledChild;
  }>> = [];
  const peers: ControlledMetaPeer[] = [];
  const defaultIdentityVault = createHostPrivateBindingIdentityVault();
  const processFactoryOptions = {
    spawn: (command: string, arguments_: readonly string[], options: AcpAgentSpawnOptions) => {
      const child = new ControlledChild(
        typeof killConfirmed === "function"
          ? killConfirmed(spawned.length)
          : killConfirmed,
      );
      spawned.push({ command, arguments: arguments_, options, child });
      return child;
    },
    signalChild: (child: AcpAgentChildProcess, signal: NodeJS.Signals) => child.kill(signal),
    terminationGraceMs: 5,
    killConfirmationMs: 5,
    createOpaqueId: (() => {
      let sequence = 0;
      return () => `acp_generation_meta_${++sequence}`;
    })(),
    identityVaultResolver: () => defaultIdentityVault,
  } as const;
  const registration: AcpMetaProfileRegistration = Object.freeze({
    metaProfileOptionId: "meta_profile_option_controlled",
    title: "Controlled ACP Meta",
    profile: metaProfile,
    descriptor: Object.freeze({
      descriptorId: "controlled-meta-current-install",
      async discoverCurrent() {
        return Object.freeze({
          canonicalLauncherPath: "/controlled/meta-acp",
          launchArguments: Object.freeze(["--stdio"]),
          observedArtifactVersion: "meta-artifact-current",
          observedUpstreamVersion: "meta-upstream-current",
          artifactDigest: `sha256:${"a".repeat(64)}`,
          trustState: "trusted" as const,
          executionConfigDigest: `sha256:${"b".repeat(64)}`,
          environment: Object.freeze({ META_CONTROLLED: "1" }),
          defaultWorkingDirectory: forbiddenTaskWorkspace,
        });
      },
    }),
    createConnection: (streams) => (handlers) => {
      const peer = new ControlledMetaPeer(
        handlers,
        behavior,
        () => String(spawned.at(-1)?.options.cwd),
        capabilities,
      );
      peers.push(peer);
      expect(streams.signal.aborted).toBe(false);
      return peer.connection();
    },
  });
  return Object.freeze({
    privateRoot,
    registration,
    processFactoryOptions,
    spawned,
    peers,
    createComposition: (overrides = {}) => createAcpMetaProviderComposition({
      profiles: [registration],
      privateRootParent: privateRoot,
      processFactoryOptions: Object.freeze({
        ...processFactoryOptions,
        ...(overrides.identityVaultResolver
          ? { identityVaultResolver: overrides.identityVaultResolver }
          : {}),
      }),
      operationTimeoutMs: overrides.operationTimeoutMs ?? 1_000,
      readinessTtlMs: 60_000,
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
      createBindingHandle: (() => {
        let sequence = 0;
        return () => `binding_handle_meta_${++sequence}`;
      })(),
      createReadinessBindingHandle: (() => {
        let sequence = 0;
        return () => `binding_handle_meta_readiness_${++sequence}`;
      })(),
      ...(overrides.onTargetLifecycleCapability
        ? { onTargetLifecycleCapability: overrides.onTargetLifecycleCapability }
        : {}),
      ...(overrides.onTargetCheckpointFactCapability
        ? { onTargetCheckpointFactCapability: overrides.onTargetCheckpointFactCapability }
        : {}),
    }),
  });
}

class ControlledChild extends EventEmitter implements AcpAgentChildProcess {
  readonly stdin: Writable = new PassThrough();
  readonly stdout: Readable = new PassThrough();
  readonly stderr: Readable = new PassThrough();
  readonly pid = 4242;
  killCalls = 0;
  readonly #killConfirmed: boolean;
  #closed = false;

  constructor(killConfirmed: boolean) {
    super();
    this.#killConfirmed = killConfirmed;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killCalls += 1;
    if (!this.#killConfirmed || this.#closed) return false;
    this.#closed = true;
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }

  crash(): void {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.emit("close", 1, null));
  }
}

class ControlledMetaPeer {
  readonly rawSessionId = rawSessionId;
  readonly handlerKeys: string[];
  readonly newSessionParams: Record<string, unknown>[] = [];
  readonly privateDirectoryChecks: Array<Readonly<{
    readonly mode: number;
    readonly entries: readonly string[];
    readonly processMatchesWire: boolean;
  }>> = [];
  promptCount = 0;
  probePromptCount = 0;
  targetPromptCount = 0;
  loadCalls = 0;
  resumeCalls = 0;
  readonly #handlers: AcpV1ClientHandlers;
  readonly #behavior: ControlledBehavior;
  readonly #processCwd: () => string;
  readonly #capabilities: Readonly<{
    readonly load: boolean;
    readonly resume: boolean;
    readonly close: boolean;
  }>;

  constructor(
    handlers: AcpV1ClientHandlers,
    behavior: ControlledBehavior,
    processCwd: () => string,
    capabilities: Readonly<{
      readonly load: boolean;
      readonly resume: boolean;
      readonly close: boolean;
    }>,
  ) {
    this.#handlers = handlers;
    this.#behavior = behavior;
    this.#processCwd = processCwd;
    this.#capabilities = capabilities;
    this.handlerKeys = Object.keys(handlers).sort();
  }

  connection(): InjectedAcpV1Connection {
    return {
      initialize: async () => ({
        protocolVersion: 1,
        agentInfo: {
          name: "Controlled Meta ACP",
          title: "Controlled Meta ACP",
          version: "current",
        },
        agentCapabilities: {
          ...(this.#capabilities.load ? { loadSession: true } : {}),
          sessionCapabilities: {
            ...(this.#capabilities.resume ? { resume: {} } : {}),
            ...(this.#capabilities.close ? { close: {} } : {}),
          },
        },
      }),
      newSession: async (value) => {
        const request = record(value);
        this.newSessionParams.push(structuredClone(request));
        return {
          sessionId: rawSessionId,
          configOptions: [modelOption(metaProfile.model)],
        };
      },
      ...(this.#capabilities.load ? {
        loadSession: async () => {
          this.loadCalls += 1;
          return { configOptions: [modelOption(metaProfile.model)] };
        },
      } : {}),
      ...(this.#capabilities.resume ? {
        resumeSession: async () => {
          this.resumeCalls += 1;
          return { configOptions: [modelOption(metaProfile.model)] };
        },
      } : {}),
      setSessionConfigOption: async () => ({ configOptions: [modelOption(metaProfile.model)] }),
      prompt: async (value) => this.prompt(value),
      cancel: async () => undefined,
      ...(this.#capabilities.close ? { closeSession: async () => ({}) } : {}),
    };
  }

  async prompt(value: unknown): Promise<unknown> {
    const request = record(value);
    this.promptCount += 1;
    const wireCwd = this.newSessionParams[0]?.cwd === undefined
      ? this.#processCwd()
      : String(this.newSessionParams[0].cwd);
    const cwdStat = await stat(wireCwd);
    this.privateDirectoryChecks.push(Object.freeze({
      mode: cwdStat.mode & 0o777,
      entries: Object.freeze(await readdir(wireCwd)),
      processMatchesWire: this.#processCwd() === wireCwd,
    }));
    if (JSON.stringify(request).includes("metaProbe")) {
      this.probePromptCount += 1;
      await this.agentText(request, "raw-meta-probe-message", '{"metaProbe":"ok"}');
      return { stopReason: "end_turn" };
    }
    this.targetPromptCount += 1;
    if (this.#behavior === "hang") {
      return new Promise<never>(() => undefined);
    }
    if (this.#behavior === "multiple") {
      await this.agentText(request, rawMessageIds[0], '{"operation":"answer","message":"old"}');
      await this.agentText(request, rawMessageIds[1], '{"operation":"answer","message":"latest"}');
      return { stopReason: "end_turn" };
    }
    if (this.#behavior === "tool") {
      try {
        await this.#handlers.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "raw-meta-tool-secret",
            title: "Forbidden tool",
            status: "pending",
          },
        });
      } catch {
        // The Host must fail this reverse notification closed.
      }
      return { stopReason: "end_turn" };
    }
    if (this.#behavior === "permission"
      || (this.#behavior === "single_then_permission" && this.targetPromptCount === 2)) {
      try {
        await this.#handlers.requestPermission({
          sessionId: request.sessionId,
          toolCall: {
            toolCallId: "raw-meta-permission-tool",
            title: "Forbidden permission",
            status: "pending",
          },
          options: [{
            optionId: "raw-meta-permission-option",
            name: "Allow",
            kind: "allow_once",
          }],
        });
      } catch {
        // The Host must reject rather than waiting for a human/tool authority.
      }
      return { stopReason: "end_turn" };
    }
    await this.agentText(
      request,
      rawMessageIds[0],
      '{"operation":"answer","message":"controlled"}',
    );
    if (this.#behavior === "transport_failure") {
      throw new Error("raw transport failure must remain private");
    }
    return { stopReason: "end_turn" };
  }

  async agentText(
    request: Record<string, unknown>,
    messageId: string,
    text: string,
  ): Promise<void> {
    await this.#handlers.sessionUpdate({
      sessionId: request.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text },
      },
    });
  }
}

function metaTurnRequest(
  metaSessionId: MetaSessionId,
  metaTurnId: string,
): AcpMetaAgentTurnRequest {
  return Object.freeze({
    metaSessionId,
    metaTurnId,
    userMetaMessageId: `meta_message_${metaTurnId}`,
    idempotencyKey: `idempotency-${metaTurnId}`,
    mode: "template_design",
    profile: metaProfile,
    targetRevision: 1,
    systemInstructions: "Return one whole JSON value and never use tools.",
    outputSchema: { type: "object" },
    context: { draft: { title: "Controlled draft" } },
    transcript: [],
    content: "Revise this configuration draft.",
  } as AcpMetaAgentTurnRequest);
}

function modelOption(model: string): Record<string, unknown> {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [{ value: model, name: "Controlled model" }],
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("controlled_wire_value_invalid");
  }
  return value as Record<string, unknown>;
}
