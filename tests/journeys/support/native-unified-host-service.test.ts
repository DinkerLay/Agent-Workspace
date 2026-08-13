import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sessionIdObservedLineageDigest } from "../../../apps/runtime-host/src/session-id-observed-lineage.js";
import type {
  AcpReleaseProductionObservation,
  AcpReleaseSemanticFact,
} from "../acp-release-attestation.js";
import {
  NATIVE_UNIFIED_HOST_PATHS,
  NATIVE_UNIFIED_HOST_RESTART_EXIT_CODE,
  commitNativeUnifiedHostDurableState,
  finalizeNativeUnifiedHostGeneration,
  readFinalizedNativeUnifiedHostAttestation,
  startNativeUnifiedHostService,
  type NativeReleaseIdentity,
  type NativeUnifiedHostServiceOptions,
} from "./native-unified-host-service.js";
import { nativeUnifiedHostStartupFailureEnvelope } from "./native-unified-host-service-cli.js";

const serviceSource = readFileSync(new URL("./native-unified-host-service.ts", import.meta.url), "utf8");
const cliSource = readFileSync(new URL("./native-unified-host-service-cli.ts", import.meta.url), "utf8");

describe("native Unified ACP-only release child", () => {
  it("has no ProviderPort, direct Provider transport, AppServer, Meta URL, or legacy attestor fallback", () => {
    const source = `${serviceSource}\n${cliSource}`;
    for (const forbidden of [
      "ProviderPort",
      "providerPorts",
      "createRuntimeProviderPorts",
      "loadRuntimeProviderPorts",
      "CodexAppServer",
      "openCodeMetaUrl",
      "OPENCODE_META_URL",
      "@agent-workspace/provider-opencode",
      "@agent-workspace/provider-codex",
      "native-release-attestors",
      "native-release-attestation-projector",
      "NativeInstallationObservation",
      "expectedLineage",
      "local-user",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(serviceSource.match(/createSessionIdUnifiedRuntimeHost\(/gu)).toHaveLength(1);
    expect(serviceSource).toContain("createSessionIdAcpProductionProviderOwner");
  });

  it("freezes cross-process restart as a 202 close-and-exit request on fixed routes", () => {
    expect(NATIVE_UNIFIED_HOST_PATHS.restart).toBe("/control/restart");
    expect(NATIVE_UNIFIED_HOST_RESTART_EXIT_CODE).toBe(75);
    expect(serviceSource).toContain("respondJson(response, 202");
    expect(serviceSource).toContain("finalizeAcceptedControlExit(observedLineage).then");
    expect(serviceSource).not.toMatch(/async function restart|function restart\(/u);
  });

  it("persists a generation only after Host cleanup mints its release capability and closes evidence last", async () => {
    const order: string[] = [];
    let cleanupAuthorized = false;
    await finalizeNativeUnifiedHostGeneration({
      observedLineage: observedLineage(),
      async closeBridge() {
        order.push("bridge_closed");
      },
      async closeHost() {
        order.push("host_closed");
        cleanupAuthorized = true;
      },
      async persistGeneration(lineage) {
        expect(cleanupAuthorized).toBe(true);
        expect(lineage).toEqual(observedLineage());
        order.push("generation_persisted");
      },
      async closeService() {
        order.push("evidence_closed");
      },
    });
    expect(order).toEqual([
      "bridge_closed",
      "host_closed",
      "generation_persisted",
      "evidence_closed",
    ]);
  });

  it("does not persist an unconfirmed generation and still closes evidence", async () => {
    const order: string[] = [];
    await expect(finalizeNativeUnifiedHostGeneration({
      observedLineage: observedLineage(),
      async closeBridge() {
        order.push("bridge_closed");
      },
      async closeHost() {
        order.push("host_close_failed");
        throw new Error("native_host_cleanup_unconfirmed");
      },
      async persistGeneration() {
        order.push("generation_persisted");
      },
      async closeService() {
        order.push("evidence_closed");
      },
    })).rejects.toThrow("native_host_cleanup_unconfirmed");
    expect(order).toEqual(["bridge_closed", "host_close_failed", "evidence_closed"]);
  });

  it("fsyncs and atomically reopens the cross-generation observation state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-observation-durable-"));
    await chmod(root, 0o700);
    const file = path.join(root, "observations.json");
    try {
      await commitNativeUnifiedHostDurableState(file, '{"generation":1}\n');
      expect(await readFile(file, "utf8")).toBe('{"generation":1}\n');
      const metadata = await lstat(file);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.nlink).toBe(1);
      if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
      expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cleans the synced temporary file when the same-directory rename failpoint rejects", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-observation-failpoint-"));
    await chmod(root, 0o700);
    const blockedTarget = path.join(root, "observations.json");
    await mkdir(blockedTarget, { mode: 0o700 });
    try {
      await expect(commitNativeUnifiedHostDurableState(
        blockedTarget,
        '{"generation":1}\n',
      )).rejects.toBeDefined();
      expect((await lstat(blockedTarget)).isDirectory()).toBe(true);
      expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reopens a prior semantic-fact generation before Host launch and rejects JSON tampering", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-observation-reopen-")));
    const runtime = path.join(root, "runtime");
    const workspace = path.join(root, "workspace");
    await mkdir(runtime, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    await chmod(root, 0o700);
    const firstOptions = validOptions();
    const stateFile = path.join(root, "native-acp-release-observations.json");
    const generation = persistedTaskGeneration(1);
    const safeState = {
      schemaVersion: 2,
      releaseIdentity: firstOptions.releaseIdentity,
      generations: [generation],
    };
    try {
      await commitNativeUnifiedHostDurableState(stateFile, `${JSON.stringify(safeState)}\n`);
      await expect(readFinalizedNativeUnifiedHostAttestation({
        stateRoot: root,
        releaseIdentity: firstOptions.releaseIdentity,
        expectedHostGenerations: [1, 2],
        expectedObservedLineageDigest: generation.observedLineage.canonicalDigest,
      })).rejects.toThrow("native_host_attestation_not_ready");
      await expect(startNativeUnifiedHostService({
        ...firstOptions,
        stateRoot: root,
        runtimeDataDirectory: runtime,
        taskWorkspaceDirectory: workspace,
        generation: 2,
      })).rejects.toThrow("acp_new_host_epoch_invalid");

      await writeFile(stateFile, `${JSON.stringify({
        ...safeState,
        generations: [{
          ...safeState.generations[0],
          checkpointFacts: [{
            ...safeState.generations[0]!.checkpointFacts[0],
            rawSessionId: "/private/raw-session-must-not-survive",
          }, ...safeState.generations[0]!.checkpointFacts.slice(1)],
        }],
      })}\n`, { mode: 0o600 });
      await chmod(stateFile, 0o600);
      await expect(startNativeUnifiedHostService({
        ...firstOptions,
        stateRoot: root,
        runtimeDataDirectory: runtime,
        taskWorkspaceDirectory: workspace,
        generation: 2,
      })).rejects.toThrow("native_host_observation_state_invalid");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reopens two finalized generations with repeated profiles but fresh qualification/process/receipt identities", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-observation-v2-")));
    await chmod(root, 0o700);
    const options = validOptions();
    const generations = [persistedTaskGeneration(1), persistedTaskGeneration(2)];
    try {
      await commitNativeUnifiedHostDurableState(
        path.join(root, "native-acp-release-observations.json"),
        `${JSON.stringify({
          schemaVersion: 2,
          releaseIdentity: options.releaseIdentity,
          generations,
        })}\n`,
      );
      const document = await readFinalizedNativeUnifiedHostAttestation({
        stateRoot: root,
        releaseIdentity: options.releaseIdentity,
        expectedHostGenerations: [1, 2],
        expectedObservedLineageDigest: generations[1]!.observedLineage.canonicalDigest,
      });
      expect(document).toMatchObject({
        schemaVersion: 2,
        finalizedHostGeneration: 2,
        generations: [{ hostGeneration: 1 }, { hostGeneration: 2 }],
      });
      expect(document.generations[0]!.productionObservations.map(({ profileRevisionId }) => profileRevisionId))
        .toEqual(document.generations[1]!.productionObservations.map(({ profileRevisionId }) => profileRevisionId));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    "qualificationDigest",
    "processGenerationDigest",
    "productionReceiptDigest",
  ] as const)("rejects reopened cross-generation %s reuse", async (field) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-observation-reuse-")));
    await chmod(root, 0o700);
    const options = validOptions();
    const first = persistedTaskGeneration(1);
    const second = persistedTaskGeneration(2);
    const reused = first.productionObservations[0]![field];
    const observations = second.productionObservations.map((observation, index) => index === 0
      ? { ...observation, [field]: reused }
      : observation);
    const checkpointFacts = field === "processGenerationDigest"
      ? second.checkpointFacts.map((fact) => fact.processGenerationDigest
          === second.productionObservations[0]!.processGenerationDigest
        ? { ...fact, processGenerationDigest: reused }
        : fact)
      : second.checkpointFacts;
    try {
      await commitNativeUnifiedHostDurableState(
        path.join(root, "native-acp-release-observations.json"),
        `${JSON.stringify({
          schemaVersion: 2,
          releaseIdentity: options.releaseIdentity,
          generations: [first, { ...second, productionObservations: observations, checkpointFacts }],
        })}\n`,
      );
      await expect(readFinalizedNativeUnifiedHostAttestation({
        stateRoot: root,
        releaseIdentity: options.releaseIdentity,
        expectedHostGenerations: [1, 2],
        expectedObservedLineageDigest: second.observedLineage.canonicalDigest,
      })).rejects.toThrow("native_host_observation_state_invalid");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a reopened fact that joins a same-named profile from another Host generation", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-observation-wrong-generation-")));
    await chmod(root, 0o700);
    const options = validOptions();
    const first = persistedTaskGeneration(1);
    const second = persistedTaskGeneration(2);
    const checkpointFacts = second.checkpointFacts.map((fact, index) => index === 0
      ? { ...fact, processGenerationDigest: first.productionObservations[0]!.processGenerationDigest }
      : fact);
    try {
      await commitNativeUnifiedHostDurableState(
        path.join(root, "native-acp-release-observations.json"),
        `${JSON.stringify({
          schemaVersion: 2,
          releaseIdentity: options.releaseIdentity,
          generations: [first, { ...second, checkpointFacts }],
        })}\n`,
      );
      await expect(readFinalizedNativeUnifiedHostAttestation({
        stateRoot: root,
        releaseIdentity: options.releaseIdentity,
        expectedHostGenerations: [1, 2],
        expectedObservedLineageDigest: second.observedLineage.canonicalDigest,
      })).rejects.toThrow("native_host_observation_state_invalid");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects startup lineage claims and obsolete nested owner options before any Host effect", async () => {
    const options = validOptions();
    await expect(startNativeUnifiedHostService({
      ...options,
      releaseIdentity: {
        ...options.releaseIdentity,
        observedLineageDigest: `sha256:${"a".repeat(64)}`,
      },
    } as never)).rejects.toThrow("native_host_release_identity_invalid");
    await expect(startNativeUnifiedHostService({
      ...options,
      providerPorts: Object.freeze([]),
    } as never)).rejects.toThrow("native_host_options_invalid");
  });

  it("binds each issuer to its one frozen cell", async () => {
    const options = validOptions();
    await expect(startNativeUnifiedHostService({
      ...options,
      releaseIdentity: {
        ...options.releaseIdentity,
        bundleCellId: "cell_codex-acp-task",
        scenarioId: "scenario_codex-acp-task",
      },
    })).rejects.toThrow("native_host_release_identity_invalid");
  });

  it("requires a parent-authorized Task workspace and forbids any Meta workspace grant", async () => {
    const options = validOptions();
    await expect(startNativeUnifiedHostService({
      ...options,
      taskWorkspaceDirectory: undefined,
    })).rejects.toThrow("native_host_task_workspace_invalid");
    await expect(startNativeUnifiedHostService({
      ...options,
      releaseIdentity: {
        ...options.releaseIdentity,
        bundleCellId: "cell_acp-meta",
        scenarioId: "scenario_acp-meta",
        issuer: "acp_meta_attestor",
      },
    })).rejects.toThrow("native_host_meta_workspace_forbidden");
  });

  it("redacts arbitrary startup failures to a stable safe envelope", () => {
    expect(nativeUnifiedHostStartupFailureEnvelope(
      new Error("/private/provider/path secret model content"),
    )).toEqual({
      type: "native_unified_host_failure",
      outcome: "FAIL",
      stage: "service_start",
      code: "native_host_start_failed",
    });
  });
});

function validOptions(): NativeUnifiedHostServiceOptions {
  const releaseIdentity: NativeReleaseIdentity = Object.freeze({
    releaseRunId: "release_run_test",
    nonce: "nonce_test",
    bundleCellId: "cell_opencode-acp-task",
    scenarioId: "scenario_opencode-acp-task",
    runtimeInstanceId: "runtime_instance_native_test",
    issuer: "opencode_acp_task_attestor",
  });
  return Object.freeze({
    stateRoot: "/private/native-state",
    runtimeDataDirectory: "/private/native-runtime",
    rendererToken: "renderer_token_1234567890",
    desktopRendererToken: "desktop_token_1234567890",
    evidenceToken: "evidence_token_1234567890",
    controlToken: "control_token_1234567890",
    allowedOrigins: Object.freeze(["http://127.0.0.1:4100"]),
    releaseIdentity,
    environment: Object.freeze({}),
    bridgePort: 41_001,
    servicePort: 41_002,
    generation: 1,
    taskWorkspaceDirectory: "/private/native-workspace",
  });
}

function persistedTaskGeneration(hostGeneration: number) {
  const productionObservations = (["conductor", "publisher", "worker", "reviewer"] as const)
    .map((role, roleIndex) => taskObservation(hostGeneration, role, roleIndex));
  let factIndex = hostGeneration * 1_000;
  const fact = (
    kind: AcpReleaseSemanticFact["kind"],
    observation: AcpReleaseProductionObservation,
  ) => {
    const {
      initialize: _initialize,
      qualificationProbeDigest: _qualificationProbeDigest,
      qualificationDigest: _qualificationDigest,
      actualPrompt: _actualPrompt,
      cleanup: _cleanup,
      productionReceiptDigest: _productionReceiptDigest,
      ...scope
    } = observation;
    return Object.freeze({
      ...scope,
      kind,
      observationDigest: digest(factIndex++),
    });
  };
  const checkpointFacts = productionObservations.flatMap((observation) => [
    fact("actual_binding_generation", observation),
    fact("prompt_receipt", observation),
    fact("latest_final_terminal_pair", observation),
    fact("restart_load_resume", observation),
  ]);
  const conductor = productionObservations.find(({ role }) => role === "conductor")!;
  const publisher = productionObservations.find(({ role }) => role === "publisher")!;
  checkpointFacts.push(
    fact("cancel_reconcile", conductor),
    fact("scoped_mcp_call", conductor),
    fact("scoped_mcp_call", publisher),
  );
  return Object.freeze({
    hostGeneration,
    observedLineage: observedLineage(),
    productionObservations: Object.freeze(productionObservations),
    checkpointFacts: Object.freeze(checkpointFacts),
  });
}

function taskObservation(
  hostGeneration: number,
  role: AcpReleaseProductionObservation["role"],
  roleIndex: number,
): AcpReleaseProductionObservation {
  const unique = hostGeneration * 100 + roleIndex * 10;
  return Object.freeze({
    schemaVersion: 1 as const,
    evidenceClass: "qualified_acp_provider" as const,
    productionLane: "opencode_acp_task_attestor" as const,
    profileRevisionId: `profile_revision_opencode-${role}`,
    providerFamily: "opencode" as const,
    acpAgentKind: "native_acp" as const,
    role,
    model: `opencode-current/model-${role}`,
    profileConfigurationDigest: digest(roleIndex + 1),
    resolutionSealDigest: digest(unique + 1),
    observedArtifactVersion: "current-observed-version",
    processGenerationDigest: digest(unique + 2),
    qualificationDigest: digest(unique + 3),
    initialize: Object.freeze({
      protocolMajor: 1 as const,
      agent: Object.freeze({ name: "opencode-acp", version: "current" }),
      capabilities: Object.freeze(["session/create", "session/prompt"]),
      extensions: Object.freeze([]),
      capabilityFingerprint: digest(unique + 4),
    }),
    qualificationProbeDigest: digest(roleIndex + 20),
    actualPrompt: Object.freeze({
      receiptObserved: true as const,
      finalObserved: true as const,
      terminalObserved: true as const,
      attemptCorrelationDigest: digest(unique + 5),
      lifecycleDigest: digest(unique + 6),
    }),
    cleanup: Object.freeze({
      bindingReleaseConfirmed: true as const,
      processExitConfirmed: true as const,
      credentialCleanupConfirmed: true as const,
      capabilityCleanupConfirmed: true as const,
      receiptDigest: digest(unique + 7),
    }),
    productionReceiptDigest: digest(unique + 8),
  });
}

function observedLineage() {
  const lineage = Object.freeze({
    schemaVersion: 1 as const,
    runtimeInstanceId: "runtime_instance_native_test",
    templateDraftIds: Object.freeze([]),
    taskSetupDraftIds: Object.freeze([]),
    taskIds: Object.freeze([]),
    runIds: Object.freeze([]),
    metaSessionIds: Object.freeze([]),
    metaTurnIds: Object.freeze([]),
    cardSessionSlotIds: Object.freeze([]),
    logicalSessionIds: Object.freeze([]),
    bindingIds: Object.freeze([]),
    messageIds: Object.freeze([]),
    messageForwardIds: Object.freeze([]),
    humanInterventionIds: Object.freeze([]),
    inputSubmissionIds: Object.freeze([]),
    sessionTurnIds: Object.freeze([]),
    sessionControlAuditIds: Object.freeze([]),
  });
  return Object.freeze({
    ...lineage,
    canonicalDigest: sessionIdObservedLineageDigest(lineage),
  });
}

function digest(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
