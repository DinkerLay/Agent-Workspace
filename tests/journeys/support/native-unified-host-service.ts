import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { assertAcpHostEpochSupervisorEnvironmentConfigured } from "../../../apps/runtime-host/src/acp-host-epoch-lease.js";
import {
  createAcpProductionHostInputs,
  loadAcpProductionConfigurationFromEnvironment,
} from "../../../apps/runtime-host/src/acp-production-configuration.js";
import { createAcpRuntimeHostPrivateAuthority } from "../../../apps/runtime-host/src/acp-runtime-host-private-authority.js";
import {
  createSessionIdAcpProductionProviderOwner,
  type SessionIdAcpProductionProviderOwner,
} from "../../../apps/runtime-host/src/session-id-acp-production-provider-owner.js";
import { createSessionIdAcpProviderSettingsHost } from "../../../apps/runtime-host/src/session-id-acp-provider-settings-host.js";
import type {
  SessionIdAcpProductionNativeReleaseObservation,
  SessionIdAcpProductionNativeReleaseScope,
  SessionIdAcpProductionNativeCheckpointFactObservation,
  SessionIdAcpProductionNativeCheckpointFactScope,
} from "../../../apps/runtime-host/src/session-id-acp-production-composition.js";
import { sessionIdObservedLineageDigest } from "../../../apps/runtime-host/src/session-id-observed-lineage.js";
import {
  createSessionIdUnifiedRuntimeBridgeServer,
  type SessionIdUnifiedRuntimeBridgeServer,
} from "../../../apps/runtime-host/src/session-id-unified-runtime-bridge.js";
import {
  createSessionIdUnifiedRuntimeHost,
  type SessionIdUnifiedObservedLineage,
  type SessionIdUnifiedRuntimeHost,
} from "../../../apps/runtime-host/src/session-id-unified-runtime-host.js";
import { assertEvidenceSafe } from "../../e2e/journey-evidence.js";
import {
  validateAcpReleaseAttestationGeneration,
  validateAcpReleaseAttestationDocument,
  validateAcpReleaseProductionObservation,
  type AcpReleaseAttestationDocument,
  type AcpReleaseAttestorIssuer,
  type AcpReleaseProductionObservation,
  type AcpReleaseSemanticFact,
} from "../acp-release-attestation.js";

const LOOPBACK_HOST = "127.0.0.1";
const WORKSPACE_ID = "workspace_journey";
const OBSERVATION_STATE_FILE = "native-acp-release-observations.json";
const MAX_PERSISTED_OBSERVATION_BYTES = 2 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PROFILE_REVISION_ID = /^profile_revision_[A-Za-z0-9_-]{1,223}$/u;
const RUNTIME_INSTANCE_ID = /^runtime_instance_[A-Za-z0-9_-]{1,223}$/u;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const TASK_ROLES = Object.freeze(["conductor", "publisher", "worker", "reviewer"] as const);
const OBSERVED_LINEAGE_KEYS = Object.freeze([
  "schemaVersion",
  "runtimeInstanceId",
  "templateDraftIds",
  "taskSetupDraftIds",
  "taskIds",
  "runIds",
  "metaSessionIds",
  "metaTurnIds",
  "cardSessionSlotIds",
  "logicalSessionIds",
  "bindingIds",
  "messageIds",
  "messageForwardIds",
  "humanInterventionIds",
  "inputSubmissionIds",
  "sessionTurnIds",
  "sessionControlAuditIds",
  "canonicalDigest",
]);

const EXPECTED_CELL_BY_ISSUER: Readonly<Record<AcpReleaseAttestorIssuer, string>> = Object.freeze({
  opencode_acp_task_attestor: "cell_opencode-acp-task",
  codex_acp_task_attestor: "cell_codex-acp-task",
  acp_meta_attestor: "cell_acp-meta",
});

export const NATIVE_UNIFIED_HOST_RESTART_EXIT_CODE = 75;

export const NATIVE_UNIFIED_HOST_PATHS = Object.freeze({
  health: "/health",
  commandLedger: "/evidence/commands",
  operationLedger: "/evidence/operations",
  observedLineage: "/evidence/observed-lineage",
  providerLedger: "/evidence/acp-provider",
  metaLedger: "/evidence/acp-meta",
  restart: "/control/restart",
  shutdown: "/control/shutdown",
});

/**
 * Launch identity only. The observed-lineage digest is deliberately absent:
 * it is recomputed from the actual Host owner repositories when evidence is
 * claimed and independently checked by the release worker.
 */
export type NativeReleaseIdentity = Readonly<{
  releaseRunId: string;
  nonce: string;
  bundleCellId: string;
  scenarioId: string;
  runtimeInstanceId: string;
  issuer: AcpReleaseAttestorIssuer;
}>;

export type NativeUnifiedHostServiceOptions = Readonly<{
  stateRoot: string;
  runtimeDataDirectory: string;
  rendererToken: string;
  desktopRendererToken: string;
  evidenceToken: string;
  controlToken: string;
  allowedOrigins: readonly string[];
  releaseIdentity: NativeReleaseIdentity;
  environment: NodeJS.ProcessEnv;
  bridgePort: number;
  servicePort: number;
  generation: number;
  /** Task-only, parent-authorized Workspace; never an ACP child cwd. */
  taskWorkspaceDirectory?: string;
  authenticatedUserId?: string;
  now?: () => string;
}>;

export type NativeUnifiedHostControlExit = "restart" | "shutdown";

export type NativeUnifiedHostService = Readonly<{
  runtimeUrl: string;
  serviceUrl: string;
  healthUrl: string;
  hostLedgerUrl: string;
  operationLedgerUrl: string;
  observedLineageUrl: string;
  nativeProviderLedgerUrl: string;
  nativeMetaLedgerUrl: string;
  runtimeInstanceId: string;
  lineageId: string;
  generation: number;
  waitForControlExit(): Promise<NativeUnifiedHostControlExit>;
  close(): Promise<void>;
}>;

type SafeHostOperation = Readonly<{
  sequence: number;
  kind: "host_started" | "restart_accepted" | "shutdown_accepted" | "release_observations_claimed";
  runtimeInstanceId: string;
  generation: number;
  observedAt: string;
}>;

type PersistedGeneration = Readonly<{
  hostGeneration: number;
  observedLineage: SessionIdUnifiedObservedLineage;
  productionObservations: readonly AcpReleaseProductionObservation[];
  /** Safe semantic Host facts only; journey checkpoint labels need a separate correlated authority. */
  checkpointFacts: readonly SessionIdAcpProductionNativeCheckpointFactObservation[];
}>;

type PersistedObservationState = Readonly<{
  schemaVersion: 2;
  releaseIdentity: NativeReleaseIdentity;
  generations: readonly PersistedGeneration[];
}>;

const EXPECTED_HOST_GENERATIONS_BY_ISSUER: Readonly<
  Record<AcpReleaseAttestorIssuer, readonly number[]>
> = Object.freeze({
  opencode_acp_task_attestor: Object.freeze([1, 2]),
  codex_acp_task_attestor: Object.freeze([1, 2]),
  acp_meta_attestor: Object.freeze([1]),
});

export async function finalizeNativeUnifiedHostGeneration(input: Readonly<{
  observedLineage: SessionIdUnifiedObservedLineage;
  closeBridge: () => Promise<void>;
  closeHost: () => Promise<void>;
  persistGeneration: (observedLineage: SessionIdUnifiedObservedLineage) => Promise<void>;
  closeService: () => Promise<void>;
}>): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await input.closeBridge();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await input.closeHost();
  } catch (error) {
    if (!failed) failure = error;
    failed = true;
  }
  if (!failed) {
    try {
      await input.persistGeneration(input.observedLineage);
    } catch (error) {
      failed = true;
      failure = error;
    }
  }
  try {
    await input.closeService();
  } catch (error) {
    if (!failed) failure = error;
    failed = true;
  }
  if (failed) throw failure;
}

/**
 * Release-only native child. It composes the same Unified Host and concrete ACP
 * production owner as the executable entry. Construction does not resolve,
 * qualify, launch, or prompt a Provider; those effects remain behind actual
 * Task/Meta commands.
 *
 * Restart is intentionally cross-process. This child never constructs a
 * second Host. The control route closes the one Host, persists only the safe
 * observations authorized by confirmed cleanup, and asks its external
 * supervisor to respawn with a fresh Host epoch.
 */
export async function startNativeUnifiedHostService(
  options: NativeUnifiedHostServiceOptions,
): Promise<NativeUnifiedHostService> {
  validateOptions(options);
  const identity = normalizeReleaseIdentity(options.releaseIdentity);
  const workspaceRoot = identity.issuer === "acp_meta_attestor"
    ? requireNoMetaWorkspace(options.taskWorkspaceDirectory)
    : await requireAuthorizedTaskWorkspace(options.taskWorkspaceDirectory);
  const stateRoot = await ensureOwnedDirectory(options.stateRoot, "native_host_state_root_invalid");
  const runtimeDataDirectory = await ensureOwnedDirectory(
    options.runtimeDataDirectory,
    "native_host_runtime_data_invalid",
  );
  const now = options.now ?? (() => new Date().toISOString());
  const authenticatedUserId = normalizeAuthenticatedUserId(options.authenticatedUserId ?? "user_local");
  const allowedOrigins = Object.freeze(options.allowedOrigins.map(normalizeOrigin));
  const observationStateFile = path.join(stateRoot, OBSERVATION_STATE_FILE);
  const persistedGenerations = [...await readPersistedGenerations(observationStateFile, identity)];
  const previousGeneration = persistedGenerations.at(-1)?.hostGeneration ?? 0;
  if (options.generation !== previousGeneration + 1) {
    throw safeError("native_host_generation_not_fresh");
  }

  assertAcpHostEpochSupervisorEnvironmentConfigured(options.environment);
  const configuration = loadAcpProductionConfigurationFromEnvironment(options.environment);
  const hostInputs = createAcpProductionHostInputs(configuration, options.environment);
  const providerSettings = createSessionIdAcpProviderSettingsHost({
    runtimeDataDirectory,
    environment: options.environment,
  });
  const privateAuthority = createAcpRuntimeHostPrivateAuthority({
    runtimeDataDirectory,
    environment: options.environment,
  });
  let privateAuthorityTransferred = false;
  let productionOwner: SessionIdAcpProductionProviderOwner | undefined;
  let host: SessionIdUnifiedRuntimeHost | undefined;
  let bridge: SessionIdUnifiedRuntimeBridgeServer | undefined;
  let serviceServer: Server | undefined;
  try {
    host = await createSessionIdUnifiedRuntimeHost({
      databasePath: path.join(runtimeDataDirectory, "runtime.sqlite"),
      authenticatedUserId,
      workspaceBootstrapGrants: workspaceRoot
        ? Object.freeze([Object.freeze({
            commandId: "command_native_workspace_authorize",
            workspaceId: WORKSPACE_ID,
            directory: workspaceRoot,
            displayName: "Release workspace",
          })])
        : Object.freeze([]),
      authorizeRetiringBindingRecovery: privateAuthority.authorizeRetiringBindingRecovery,
      createId(kind) {
        return kind === "runtime_instance"
          ? identity.runtimeInstanceId
          : `${kind}_${randomUUID().replaceAll("-", "")}`;
      },
      async createProviderOwner(input) {
        if (productionOwner) throw safeError("native_host_provider_owner_duplicate");
        const owner = await createSessionIdAcpProductionProviderOwner({
          input,
          privateAuthority,
          configuration,
          hostInputs,
          providerSettings,
          retainPrivateAuthority: () => { privateAuthorityTransferred = true; },
        });
        privateAuthorityTransferred = true;
        productionOwner = owner;
        return owner;
      },
    });
    if (host.runtimeInstanceId !== identity.runtimeInstanceId || !productionOwner) {
      throw safeError("native_host_runtime_identity_mismatch");
    }
    bridge = createSessionIdUnifiedRuntimeBridgeServer({
      host,
      rendererToken: options.rendererToken,
      desktopRendererToken: options.desktopRendererToken,
      evidenceToken: options.evidenceToken,
      allowedOrigins,
      authorizeTask: (taskId, ownerId) => ownerId === host!.authenticatedUserId
        && host!.readWorkspace().tasks.some((task) => task.taskId === taskId),
      authorizeCommand: (_command, ownerId) => ownerId === host!.authenticatedUserId,
    });
    const bridgeAddress = await bridge.listen(options.bridgePort, LOOPBACK_HOST);
    if (bridgeAddress.port !== options.bridgePort) throw safeError("native_host_bridge_port_drift");

    const operations: SafeHostOperation[] = [];
    let closePromise: Promise<void> | undefined;
    let closing = false;
    let controlExitReason: NativeUnifiedHostControlExit | undefined;
    let resolveControlExit: ((reason: NativeUnifiedHostControlExit) => void) | undefined;
    let rejectControlExit: ((error: unknown) => void) | undefined;
    const controlExit = new Promise<NativeUnifiedHostControlExit>((resolve, reject) => {
      resolveControlExit = resolve;
      rejectControlExit = reject;
    });
    const recordOperation = (kind: SafeHostOperation["kind"]): void => {
      operations.push(Object.freeze({
        sequence: operations.length + 1,
        kind,
        runtimeInstanceId: identity.runtimeInstanceId,
        generation: options.generation,
        observedAt: requiredTimestamp(now()),
      }));
    };
    recordOperation("host_started");

    serviceServer = createServer((request, response) => {
      void handleServiceRequest(request, response).catch((error: unknown) => {
        if (!response.headersSent) respondError(response, 500, safeCode(error, "native_host_request_failed"));
        else response.destroy();
      });
    });
    const serviceAddress = await listen(serviceServer, options.servicePort);
    if (serviceAddress.port !== options.servicePort) throw safeError("native_host_service_port_drift");
    const serviceUrl = `http://${LOOPBACK_HOST}:${serviceAddress.port}`;
    const lineageId = `session_id_native_lineage_${identity.runtimeInstanceId}`;

    return Object.freeze({
      runtimeUrl: bridgeAddress.url,
      serviceUrl,
      healthUrl: `${serviceUrl}${NATIVE_UNIFIED_HOST_PATHS.health}`,
      hostLedgerUrl: `${serviceUrl}${NATIVE_UNIFIED_HOST_PATHS.commandLedger}`,
      operationLedgerUrl: `${serviceUrl}${NATIVE_UNIFIED_HOST_PATHS.operationLedger}`,
      observedLineageUrl: `${serviceUrl}${NATIVE_UNIFIED_HOST_PATHS.observedLineage}`,
      nativeProviderLedgerUrl: `${serviceUrl}${NATIVE_UNIFIED_HOST_PATHS.providerLedger}`,
      nativeMetaLedgerUrl: `${serviceUrl}${NATIVE_UNIFIED_HOST_PATHS.metaLedger}`,
      runtimeInstanceId: identity.runtimeInstanceId,
      lineageId,
      generation: options.generation,
      waitForControlExit: () => controlExit,
      close: closeOwnedResources,
    });

    async function handleServiceRequest(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> {
      const target = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (closing) return respondError(response, 503, "native_host_control_exit_in_progress");
      if (request.method === "GET" && target.pathname === NATIVE_UNIFIED_HOST_PATHS.health) {
        return respondJson(response, 200, Object.freeze({
          schemaVersion: 1,
          status: "ready",
          runtimeInstanceId: identity.runtimeInstanceId,
          generation: options.generation,
          issuer: identity.issuer,
        }));
      }
      if (request.method === "GET" && isEvidencePath(target.pathname)) {
        if (!authorizedBearer(request, options.evidenceToken)) {
          return respondError(response, 401, "native_host_evidence_unauthorized");
        }
        if (target.pathname === NATIVE_UNIFIED_HOST_PATHS.commandLedger) {
          return respondJson(response, 200, requiredHost().readCommandEvidence());
        }
        if (target.pathname === NATIVE_UNIFIED_HOST_PATHS.operationLedger) {
          return respondJson(response, 200, Object.freeze([...operations]));
        }
        if (target.pathname === NATIVE_UNIFIED_HOST_PATHS.observedLineage) {
          return respondJson(response, 200, requiredHost().readObservedLineage());
        }
        if (target.pathname === NATIVE_UNIFIED_HOST_PATHS.providerLedger
          && identity.issuer === "acp_meta_attestor") {
          return respondError(response, 404, "native_host_attestation_lane_unavailable");
        }
        if (target.pathname === NATIVE_UNIFIED_HOST_PATHS.metaLedger
          && identity.issuer !== "acp_meta_attestor") {
          return respondError(response, 404, "native_host_attestation_lane_unavailable");
        }
        try {
          return respondJson(response, 200, await materializeAttestation());
        } catch (error) {
          const code = safeCode(error, "native_host_attestation_not_ready");
          return respondError(response, code === "native_host_attestation_not_ready" ? 409 : 500, code);
        }
      }
      if (request.method === "POST"
        && (target.pathname === NATIVE_UNIFIED_HOST_PATHS.restart
          || target.pathname === NATIVE_UNIFIED_HOST_PATHS.shutdown)) {
        if (!authorizedBearer(request, options.controlToken)) {
          return respondError(response, 401, "native_host_control_unauthorized");
        }
        await assertEmptyBody(request);
        if (controlExitReason) return respondError(response, 409, "native_host_control_already_accepted");
        const reason: NativeUnifiedHostControlExit = target.pathname === NATIVE_UNIFIED_HOST_PATHS.restart
          ? "restart"
          : "shutdown";
        controlExitReason = reason;
        recordOperation(reason === "restart" ? "restart_accepted" : "shutdown_accepted");
        const observedLineage = requiredHost().readObservedLineage();
        respondJson(response, 202, Object.freeze({
          schemaVersion: 1,
          outcome: "accepted",
          reason,
          runtimeInstanceId: identity.runtimeInstanceId,
          generation: options.generation,
        }));
        void finalizeAcceptedControlExit(observedLineage).then(
          () => resolveControlExit?.(reason),
          (error: unknown) => rejectControlExit?.(error),
        );
        return;
      }
      respondError(response, 404, "native_host_route_not_found");
    }

    async function materializeAttestation(): Promise<AcpReleaseAttestationDocument> {
      const expectedHostGenerations = EXPECTED_HOST_GENERATIONS_BY_ISSUER[identity.issuer];
      if (!sameNumbers(
        persistedGenerations.map(({ hostGeneration }) => hostGeneration),
        expectedHostGenerations,
      )) {
        throw safeError("native_host_attestation_not_ready");
      }
      const finalLineageDigest = persistedGenerations.at(-1)?.observedLineage.canonicalDigest;
      if (!finalLineageDigest) throw safeError("native_host_attestation_not_ready");
      return materializePersistedAttestation({
        identity,
        persistedGenerations,
        expectedHostGenerations,
        expectedObservedLineageDigest: finalLineageDigest,
      });
    }

    async function captureGenerationSnapshot(
      observedLineage: SessionIdUnifiedObservedLineage,
    ): Promise<void> {
      const owner = requiredProductionOwner();
      const summaries = owner.nativeReleaseObservations.list()
        .filter(({ scope }) => scope.productionLane === identity.issuer);
      assertReleaseSummaries(identity.issuer, summaries.map(({ scope }) => scope));
      const claimed = summaries.map(({ capability, scope }) =>
        owner.nativeReleaseObservations.claim({ capability, expectedScope: scope }));
      const observations = claimed.map(toReleaseObservation);
      const checkpointSummaries = owner.nativeReleaseObservations.listCheckpointFacts()
        .filter(({ scope }) => scope.productionLane === identity.issuer);
      assertCheckpointFactSummaries(identity.issuer, checkpointSummaries.map(({ scope }) => scope));
      const checkpointFacts = checkpointSummaries.map(({ capability, scope }) => (
        owner.nativeReleaseObservations.claimCheckpointFact({
          capability,
          expectedScope: scope,
        })
      ));
      if (persistedGenerations.some(({ hostGeneration }) => hostGeneration === options.generation)) {
        throw safeError("native_host_generation_already_persisted");
      }
      assertNoObservationReuse(observations);
      assertNoCheckpointFactReuse(checkpointFacts);
      const generation = Object.freeze({
        hostGeneration: options.generation,
        observedLineage,
        productionObservations: Object.freeze(observations),
        checkpointFacts: Object.freeze(checkpointFacts),
      });
      assertCompletePersistedGeneration(identity.issuer, generation);
      persistedGenerations.push(generation);
      assertNoObservationReuse(persistedGenerations.flatMap((entry) => entry.productionObservations));
      assertNoCheckpointFactReuse(persistedGenerations.flatMap((entry) => entry.checkpointFacts));
      assertCheckpointProfilesObserved(persistedGenerations);
      await writePersistedGenerations(observationStateFile, identity, persistedGenerations);
      if (observations.length > 0 || checkpointFacts.length > 0) {
        recordOperation("release_observations_claimed");
      }
    }

    function requiredHost(): SessionIdUnifiedRuntimeHost {
      if (!host) throw safeError("native_host_closed");
      return host;
    }

    function requiredProductionOwner(): SessionIdAcpProductionProviderOwner {
      if (!productionOwner) throw safeError("native_host_provider_owner_missing");
      return productionOwner;
    }

    function finalizeAcceptedControlExit(
      observedLineage: SessionIdUnifiedObservedLineage,
    ): Promise<void> {
      return finalizeOwnedResources(observedLineage, true);
    }

    function closeOwnedResources(): Promise<void> {
      if (closePromise) return closePromise;
      return finalizeOwnedResources(requiredHost().readObservedLineage(), false);
    }

    function finalizeOwnedResources(
      observedLineage: SessionIdUnifiedObservedLineage,
      persistGeneration: boolean,
    ): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      const currentBridge = bridge;
      bridge = undefined;
      const currentHost = host;
      host = undefined;
      const currentServer = serviceServer;
      serviceServer = undefined;
      closePromise = finalizeNativeUnifiedHostGeneration({
        observedLineage,
        async closeBridge() {
          await currentBridge?.close();
        },
        async closeHost() {
          await currentHost?.close();
        },
        async persistGeneration(lineage) {
          if (persistGeneration) await captureGenerationSnapshot(lineage);
        },
        async closeService() {
          if (currentServer?.listening) await closeServer(currentServer);
        },
      });
      return closePromise;
    }
  } catch (error) {
    const cleanup = await Promise.allSettled([
      ...(serviceServer?.listening ? [closeServer(serviceServer)] : []),
      ...(bridge ? [bridge.close()] : []),
      ...(host ? [host.close()] : []),
    ]);
    if (!host && !privateAuthorityTransferred) {
      try {
        privateAuthority.close();
      } catch (cleanupError) {
        throw cleanupError;
      }
    }
    const failure = cleanup.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    throw error;
  }
}

function validateOptions(value: NativeUnifiedHostServiceOptions): void {
  const allowedKeys = [
    "allowedOrigins",
    "bridgePort",
    "controlToken",
    "desktopRendererToken",
    "environment",
    "evidenceToken",
    "generation",
    "releaseIdentity",
    "rendererToken",
    "runtimeDataDirectory",
    "servicePort",
    "stateRoot",
  ];
  if (!isRecord(value)
    || !sameKeys(value, allowedKeys, ["authenticatedUserId", "now", "taskWorkspaceDirectory"])
    || typeof value.stateRoot !== "string"
    || !path.isAbsolute(value.stateRoot)
    || typeof value.runtimeDataDirectory !== "string"
    || !path.isAbsolute(value.runtimeDataDirectory)
    || !Array.isArray(value.allowedOrigins)
    || value.allowedOrigins.length === 0
    || !value.allowedOrigins.every((entry) => typeof entry === "string")
    || !isRecord(value.environment)
    || !validPort(value.bridgePort)
    || !validPort(value.servicePort)
    || value.bridgePort === value.servicePort
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || value.generation > 1_000_000
    || !validSecret(value.rendererToken)
    || !validSecret(value.desktopRendererToken)
    || !validSecret(value.evidenceToken)
    || !validSecret(value.controlToken)
    || new Set([
      value.rendererToken,
      value.desktopRendererToken,
      value.evidenceToken,
      value.controlToken,
    ]).size !== 4
    || (value.taskWorkspaceDirectory !== undefined
      && (typeof value.taskWorkspaceDirectory !== "string" || !path.isAbsolute(value.taskWorkspaceDirectory)))
    || (value.authenticatedUserId !== undefined && typeof value.authenticatedUserId !== "string")
    || (value.now !== undefined && typeof value.now !== "function")) {
    throw safeError("native_host_options_invalid");
  }
  normalizeReleaseIdentity(value.releaseIdentity);
}

function normalizeReleaseIdentity(value: NativeReleaseIdentity): NativeReleaseIdentity {
  if (!isRecord(value)
    || !sameKeys(value, [
      "bundleCellId",
      "issuer",
      "nonce",
      "releaseRunId",
      "runtimeInstanceId",
      "scenarioId",
    ])
    || (value.issuer !== "opencode_acp_task_attestor"
      && value.issuer !== "codex_acp_task_attestor"
      && value.issuer !== "acp_meta_attestor")
    || value.bundleCellId !== EXPECTED_CELL_BY_ISSUER[value.issuer]
    || value.scenarioId !== value.bundleCellId.replace("cell_", "scenario_")
    || !RUNTIME_INSTANCE_ID.test(requiredSafeText(value.runtimeInstanceId))
    || !SAFE_TEXT.test(requiredSafeText(value.releaseRunId))
    || !SAFE_TEXT.test(requiredSafeText(value.nonce))) {
    throw safeError("native_host_release_identity_invalid");
  }
  return Object.freeze({
    releaseRunId: value.releaseRunId,
    nonce: value.nonce,
    bundleCellId: value.bundleCellId,
    scenarioId: value.scenarioId,
    runtimeInstanceId: value.runtimeInstanceId,
    issuer: value.issuer,
  });
}

function assertReleaseSummaries(
  issuer: AcpReleaseAttestorIssuer,
  scopes: readonly SessionIdAcpProductionNativeReleaseScope[],
): void {
  for (const scope of scopes) {
    const valid = scope.productionLane === issuer
      && (issuer === "opencode_acp_task_attestor"
        ? scope.evidenceClass === "qualified_acp_provider"
          && scope.providerFamily === "opencode"
          && scope.acpAgentKind === "native_acp"
          && TASK_ROLES.includes(scope.role as typeof TASK_ROLES[number])
        : issuer === "codex_acp_task_attestor"
          ? scope.evidenceClass === "qualified_acp_provider"
            && scope.providerFamily === "codex"
            && scope.acpAgentKind === "codex_acp"
            && TASK_ROLES.includes(scope.role as typeof TASK_ROLES[number])
          : scope.evidenceClass === "qualified_acp_meta" && scope.role === "meta");
    if (!valid) throw safeError("native_host_release_scope_mismatch");
  }
}

function toReleaseObservation(
  value: SessionIdAcpProductionNativeReleaseObservation,
): AcpReleaseProductionObservation {
  assertEvidenceSafe(value);
  if ((value.providerFamily !== "opencode" && value.providerFamily !== "codex")
    || (value.acpAgentKind !== "native_acp" && value.acpAgentKind !== "codex_acp")
    || value.initialize.protocolMajor !== 1) {
    throw safeError("native_host_release_scope_mismatch");
  }
  return Object.freeze({
    ...value,
    providerFamily: value.providerFamily,
    acpAgentKind: value.acpAgentKind,
    initialize: Object.freeze({
      ...value.initialize,
      protocolMajor: 1 as const,
    }),
  });
}

function assertCheckpointFactSummaries(
  issuer: AcpReleaseAttestorIssuer,
  scopes: readonly SessionIdAcpProductionNativeCheckpointFactScope[],
): void {
  assertReleaseSummaries(issuer, scopes);
  for (const scope of scopes) {
    const metaKind = isMetaCheckpointKind(scope.kind);
    if (metaKind !== (issuer === "acp_meta_attestor")
      || (scope.kind === "scoped_mcp_call"
        && scope.role !== "conductor"
        && scope.role !== "publisher")) {
      throw safeError("native_host_checkpoint_scope_mismatch");
    }
  }
}

function toSemanticFact(
  value: SessionIdAcpProductionNativeCheckpointFactObservation,
): AcpReleaseSemanticFact {
  return Object.freeze({
    kind: value.kind,
    profileRevisionId: value.profileRevisionId,
    processGenerationDigest: value.processGenerationDigest,
    observationDigest: value.observationDigest,
  });
}

function isMetaCheckpointKind(
  value: SessionIdAcpProductionNativeCheckpointFactScope["kind"],
): boolean {
  return value === "independent_process"
    || value === "no_tools"
    || value === "no_cwd"
    || value === "no_workspace"
    || value === "strict_whole_final"
    || value === "permission_rejected"
    || value === "cold_reconcile";
}

function hasExactRoleCoverage(
  issuer: AcpReleaseAttestorIssuer,
  values: readonly AcpReleaseProductionObservation[],
): boolean {
  const expected: readonly AcpReleaseProductionObservation["role"][] =
    issuer === "acp_meta_attestor" ? ["meta"] : TASK_ROLES;
  const roles = values.map(({ role }) => role);
  return roles.length === expected.length
    && new Set(roles).size === roles.length
    && expected.every((role) => roles.includes(role));
}

function assertNoObservationReuse(values: readonly AcpReleaseProductionObservation[]): void {
  for (const field of [
    "qualificationDigest",
    "processGenerationDigest",
    "productionReceiptDigest",
  ] as const) {
    const entries = values.map((entry) => entry[field]);
    if (new Set(entries).size !== entries.length) throw safeError("native_host_release_observation_reused");
  }
}

function assertNoCheckpointFactReuse(
  values: readonly SessionIdAcpProductionNativeCheckpointFactObservation[],
): void {
  const identities = values.map(({ kind, profileRevisionId, processGenerationDigest }) => (
    `${kind}|${profileRevisionId}|${processGenerationDigest}`
  ));
  const digests = values.map(({ observationDigest }) => observationDigest);
  if (new Set(identities).size !== identities.length || new Set(digests).size !== digests.length) {
    throw safeError("native_host_checkpoint_fact_reused");
  }
}

function assertCheckpointProfilesObserved(generations: readonly PersistedGeneration[]): void {
  for (const generation of generations) {
    for (const fact of generation.checkpointFacts) {
      const observation = generation.productionObservations.find((candidate) => (
        candidate.profileRevisionId === fact.profileRevisionId
        && candidate.processGenerationDigest === fact.processGenerationDigest
      ));
      if (!observation
        || fact.productionLane !== observation.productionLane
        || fact.providerFamily !== observation.providerFamily
        || fact.acpAgentKind !== observation.acpAgentKind
        || fact.role !== observation.role
        || fact.model !== observation.model
        || fact.profileConfigurationDigest !== observation.profileConfigurationDigest
        || fact.resolutionSealDigest !== observation.resolutionSealDigest) {
        throw safeError("native_host_checkpoint_profile_unobserved");
      }
    }
  }
}

function assertCompletePersistedGeneration(
  issuer: AcpReleaseAttestorIssuer,
  generation: PersistedGeneration,
): void {
  if (generation.observedLineage.runtimeInstanceId.length === 0
    || !SHA256.test(generation.observedLineage.canonicalDigest)
    || !hasExactRoleCoverage(issuer, generation.productionObservations)
    || new Set(generation.productionObservations.map(({ profileRevisionId }) => profileRevisionId)).size
      !== generation.productionObservations.length) {
    throw safeError("native_host_attestation_generation_incomplete");
  }
  try {
    validateAcpReleaseAttestationGeneration({
      hostGeneration: generation.hostGeneration,
      observedLineageDigest: generation.observedLineage.canonicalDigest,
      semanticFacts: generation.checkpointFacts.map(toSemanticFact),
      productionObservations: generation.productionObservations,
    }, issuer, generation.hostGeneration);
  } catch {
    throw safeError("native_host_attestation_generation_incomplete");
  }
}

function materializePersistedAttestation(input: Readonly<{
  identity: NativeReleaseIdentity;
  persistedGenerations: readonly PersistedGeneration[];
  expectedHostGenerations: readonly number[];
  expectedObservedLineageDigest: string;
}>): AcpReleaseAttestationDocument {
  const document = Object.freeze({
    schemaVersion: 2 as const,
    issuer: input.identity.issuer,
    releaseRunId: input.identity.releaseRunId,
    nonce: input.identity.nonce,
    bundleCellId: input.identity.bundleCellId,
    scenarioId: input.identity.scenarioId,
    runtimeInstanceId: input.identity.runtimeInstanceId,
    finalizedHostGeneration: input.persistedGenerations.at(-1)?.hostGeneration,
    generations: Object.freeze(input.persistedGenerations.map((generation) => Object.freeze({
      hostGeneration: generation.hostGeneration,
      observedLineageDigest: generation.observedLineage.canonicalDigest,
      semanticFacts: Object.freeze(generation.checkpointFacts.map(toSemanticFact)),
      productionObservations: Object.freeze([...generation.productionObservations]),
    }))),
  });
  return validateAcpReleaseAttestationDocument(document, {
    ...input.identity,
    observedLineageDigest: input.expectedObservedLineageDigest,
    expectedHostGenerations: input.expectedHostGenerations,
  });
}

/**
 * Post-cleanup reader for the parent release worker. It cannot observe a live
 * Host or mint facts; it reopens only the atomically persisted generation log.
 */
export async function readFinalizedNativeUnifiedHostAttestation(input: Readonly<{
  stateRoot: string;
  releaseIdentity: NativeReleaseIdentity;
  expectedHostGenerations: readonly number[];
  expectedObservedLineageDigest: string;
}>): Promise<AcpReleaseAttestationDocument> {
  const identity = normalizeReleaseIdentity(input.releaseIdentity);
  const stateRoot = await validateOwnedDirectory(input.stateRoot, "native_host_state_root_invalid");
  const generations = await readPersistedGenerations(
    path.join(stateRoot, OBSERVATION_STATE_FILE),
    identity,
  );
  if (!sameNumbers(generations.map(({ hostGeneration }) => hostGeneration), input.expectedHostGenerations)) {
    throw safeError("native_host_attestation_not_ready");
  }
  try {
    return materializePersistedAttestation({
      identity,
      persistedGenerations: generations,
      expectedHostGenerations: input.expectedHostGenerations,
      expectedObservedLineageDigest: input.expectedObservedLineageDigest,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "native_host_attestation_not_ready") throw error;
    throw safeError("native_host_attestation_invalid");
  }
}

async function readPersistedGenerations(
  file: string,
  identity: NativeReleaseIdentity,
): Promise<readonly PersistedGeneration[]> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return Object.freeze([]);
    throw safeError("native_host_observation_state_invalid");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.size < 1 || metadata.size > MAX_PERSISTED_OBSERVATION_BYTES
    || metadata.nlink !== 1
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
    throw safeError("native_host_observation_state_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
    assertEvidenceSafe(value);
  } catch {
    throw safeError("native_host_observation_state_invalid");
  }
  if (!isRecord(value)
    || !sameKeys(value, ["generations", "releaseIdentity", "schemaVersion"])
    || value.schemaVersion !== 2
    || !sameReleaseIdentity(value.releaseIdentity, identity)
    || !Array.isArray(value.generations)) {
    throw safeError("native_host_observation_state_invalid");
  }
  const generations: PersistedGeneration[] = [];
  for (const entry of value.generations) {
    const hostGeneration = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Readonly<Record<string, unknown>>).hostGeneration
      : undefined;
    if (!isRecord(entry)
      || !sameKeys(entry, [
        "checkpointFacts",
        "hostGeneration",
        "observedLineage",
        "productionObservations",
      ])
      || typeof hostGeneration !== "number"
      || !Number.isSafeInteger(hostGeneration)
      || hostGeneration < 1
      || !Array.isArray(entry.productionObservations)
      || !Array.isArray(entry.checkpointFacts)) {
      throw safeError("native_host_observation_state_invalid");
    }
    generations.push(Object.freeze({
      hostGeneration,
      observedLineage: readObservedLineage(entry.observedLineage, identity.runtimeInstanceId),
      productionObservations: Object.freeze(entry.productionObservations.map((observation) => (
        readProductionObservation(observation, identity.issuer)
      ))),
      checkpointFacts: Object.freeze(entry.checkpointFacts.map((fact) => (
        readCheckpointFact(fact, identity.issuer)
      ))),
    }));
  }
  try {
    if (new Set(generations.map(({ hostGeneration }) => hostGeneration)).size !== generations.length
      || generations.some((entry, index) => entry.hostGeneration !== index + 1)) {
      throw safeError("native_host_observation_state_invalid");
    }
    for (const generation of generations) assertCompletePersistedGeneration(identity.issuer, generation);
    assertNoObservationReuse(generations.flatMap((entry) => entry.productionObservations));
    assertNoCheckpointFactReuse(generations.flatMap((entry) => entry.checkpointFacts));
    assertCheckpointProfilesObserved(generations);
  } catch {
    throw safeError("native_host_observation_state_invalid");
  }
  return Object.freeze(generations);
}

function readProductionObservation(
  value: unknown,
  issuer: AcpReleaseAttestorIssuer,
): AcpReleaseProductionObservation {
  try {
    return validateAcpReleaseProductionObservation(value, issuer);
  } catch {
    throw safeError("native_host_observation_state_invalid");
  }
}

function readObservedLineage(
  value: unknown,
  runtimeInstanceId: string,
): SessionIdUnifiedObservedLineage {
  if (!isRecord(value)
    || !sameKeys(value, OBSERVED_LINEAGE_KEYS)
    || value.schemaVersion !== 1
    || value.runtimeInstanceId !== runtimeInstanceId
    || !SHA256.test(requiredSafeText(value.canonicalDigest))) {
    throw safeError("native_host_observation_state_invalid");
  }
  const arrayKeys = OBSERVED_LINEAGE_KEYS.filter((key) => key.endsWith("Ids"));
  if (arrayKeys.some((key) => !Array.isArray(value[key])
    || !(value[key] as readonly unknown[]).every((entry) => (
      typeof entry === "string" && entry.length > 0 && entry.length <= 256 && !entry.includes("\0")
    ))
    || new Set(value[key] as readonly unknown[]).size !== (value[key] as readonly unknown[]).length)) {
    throw safeError("native_host_observation_state_invalid");
  }
  const canonical = Object.freeze({
    schemaVersion: 1 as const,
    runtimeInstanceId,
    templateDraftIds: Object.freeze([...(value.templateDraftIds as readonly string[])]),
    taskSetupDraftIds: Object.freeze([...(value.taskSetupDraftIds as readonly string[])]),
    taskIds: Object.freeze([...(value.taskIds as readonly string[])]),
    runIds: Object.freeze([...(value.runIds as readonly string[])]),
    metaSessionIds: Object.freeze([...(value.metaSessionIds as readonly string[])]),
    metaTurnIds: Object.freeze([...(value.metaTurnIds as readonly string[])]),
    cardSessionSlotIds: Object.freeze([...(value.cardSessionSlotIds as readonly string[])]),
    logicalSessionIds: Object.freeze([...(value.logicalSessionIds as readonly string[])]),
    bindingIds: Object.freeze([...(value.bindingIds as readonly string[])]),
    messageIds: Object.freeze([...(value.messageIds as readonly string[])]),
    messageForwardIds: Object.freeze([...(value.messageForwardIds as readonly string[])]),
    humanInterventionIds: Object.freeze([...(value.humanInterventionIds as readonly string[])]),
    inputSubmissionIds: Object.freeze([...(value.inputSubmissionIds as readonly string[])]),
    sessionTurnIds: Object.freeze([...(value.sessionTurnIds as readonly string[])]),
    sessionControlAuditIds: Object.freeze([...(value.sessionControlAuditIds as readonly string[])]),
  });
  if (sessionIdObservedLineageDigest(canonical) !== value.canonicalDigest) {
    throw safeError("native_host_observation_state_invalid");
  }
  return Object.freeze({
    ...canonical,
    canonicalDigest: value.canonicalDigest as string,
  });
}

function readCheckpointFact(
  value: unknown,
  issuer: AcpReleaseAttestorIssuer,
): SessionIdAcpProductionNativeCheckpointFactObservation {
  assertEvidenceSafe(value);
  if (!isRecord(value)
    || !sameKeys(value, [
      "acpAgentKind",
      "evidenceClass",
      "kind",
      "model",
      "observationDigest",
      "observedArtifactVersion",
      "processGenerationDigest",
      "productionLane",
      "profileConfigurationDigest",
      "profileRevisionId",
      "providerFamily",
      "resolutionSealDigest",
      "role",
      "schemaVersion",
    ], ["observedUpstreamVersion"])
    || value.schemaVersion !== 1
    || value.evidenceClass !== "qualified_acp_provider"
      && value.evidenceClass !== "qualified_acp_meta"
    || !PROFILE_REVISION_ID.test(requiredSafeText(value.profileRevisionId))
    || !SHA256.test(requiredSafeText(value.observationDigest))
    || !SHA256.test(requiredSafeText(value.profileConfigurationDigest))
    || !SHA256.test(requiredSafeText(value.resolutionSealDigest))
    || !SHA256.test(requiredSafeText(value.processGenerationDigest))) {
    throw safeError("native_host_observation_state_invalid");
  }
  const kind = value.kind as SessionIdAcpProductionNativeCheckpointFactScope["kind"];
  if (!isCheckpointKind(kind) || isMetaCheckpointKind(kind) !== (issuer === "acp_meta_attestor")) {
    throw safeError("native_host_observation_state_invalid");
  }
  const projected = deepFreeze(value) as SessionIdAcpProductionNativeCheckpointFactObservation;
  assertCheckpointFactSummaries(issuer, [projected]);
  return projected;
}

function isCheckpointKind(
  value: unknown,
): value is SessionIdAcpProductionNativeCheckpointFactScope["kind"] {
  return value === "actual_binding_generation"
    || value === "prompt_receipt"
    || value === "latest_final_terminal_pair"
    || value === "cancel_reconcile"
    || value === "restart_load_resume"
    || value === "scoped_mcp_call"
    || value === "independent_process"
    || value === "no_tools"
    || value === "no_cwd"
    || value === "no_workspace"
    || value === "strict_whole_final"
    || value === "permission_rejected"
    || value === "cold_reconcile";
}

async function writePersistedGenerations(
  file: string,
  identity: NativeReleaseIdentity,
  generations: readonly PersistedGeneration[],
): Promise<void> {
  const state: PersistedObservationState = Object.freeze({
    schemaVersion: 2,
    releaseIdentity: identity,
    generations: Object.freeze([...generations]),
  });
  assertEvidenceSafe(state);
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_OBSERVATION_BYTES) {
    throw safeError("native_host_observation_state_too_large");
  }
  await commitNativeUnifiedHostDurableState(file, serialized);
}

/** Same-directory atomic durable commit used for cross-process observation truth. */
export async function commitNativeUnifiedHostDurableState(
  file: string,
  serialized: string,
): Promise<void> {
  if (!path.isAbsolute(file) || typeof serialized !== "string" || serialized.length < 1) {
    throw safeError("native_host_observation_state_invalid");
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags = fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_WRONLY
      | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(temporary, flags, 0o600);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
      throw safeError("native_host_observation_state_invalid");
    }
    const directoryFlags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0);
    const directory = await open(path.dirname(file), directoryFlags);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sameReleaseIdentity(value: unknown, expected: NativeReleaseIdentity): boolean {
  try {
    const actual = normalizeReleaseIdentity(value as NativeReleaseIdentity);
    return actual.releaseRunId === expected.releaseRunId
      && actual.nonce === expected.nonce
      && actual.bundleCellId === expected.bundleCellId
      && actual.scenarioId === expected.scenarioId
      && actual.runtimeInstanceId === expected.runtimeInstanceId
      && actual.issuer === expected.issuer;
  } catch {
    return false;
  }
}

async function ensureOwnedDirectory(value: string, code: string): Promise<string> {
  const requested = path.resolve(value);
  try {
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const metadata = await lstat(requested);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
      throw safeError(code);
    }
    await chmod(requested, 0o700);
    if (await realpath(requested) !== requested) throw safeError(code);
    return requested;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw safeError(code);
  }
}

async function validateOwnedDirectory(value: string, code: string): Promise<string> {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) throw safeError(code);
  try {
    const metadata = await lstat(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
      || await realpath(value) !== value) {
      throw safeError(code);
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw safeError(code);
  }
}

async function requireAuthorizedTaskWorkspace(value: string | undefined): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw safeError("native_host_task_workspace_invalid");
  }
  try {
    const metadata = await lstat(value);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o700)
      || (uid !== undefined && metadata.uid !== uid)
      || await realpath(value) !== value) {
      throw safeError("native_host_task_workspace_invalid");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === "native_host_task_workspace_invalid") throw error;
    throw safeError("native_host_task_workspace_invalid");
  }
}

function requireNoMetaWorkspace(value: string | undefined): undefined {
  if (value !== undefined) throw safeError("native_host_meta_workspace_forbidden");
  return undefined;
}

function normalizeOrigin(value: string): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw safeError("native_host_allowed_origin_invalid");
  }
  if ((origin.protocol !== "http:" && origin.protocol !== "https:")
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw safeError("native_host_allowed_origin_invalid");
  }
  return origin.origin;
}

function normalizeAuthenticatedUserId(value: string): string {
  if (!/^user_[A-Za-z0-9_-]{1,251}$/u.test(value)) throw safeError("native_host_user_invalid");
  return value;
}

function isEvidencePath(value: string): boolean {
  return value === NATIVE_UNIFIED_HOST_PATHS.commandLedger
    || value === NATIVE_UNIFIED_HOST_PATHS.operationLedger
    || value === NATIVE_UNIFIED_HOST_PATHS.observedLineage
    || value === NATIVE_UNIFIED_HOST_PATHS.providerLedger
    || value === NATIVE_UNIFIED_HOST_PATHS.metaLedger;
}

function authorizedBearer(request: IncomingMessage, expected: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

async function assertEmptyBody(request: IncomingMessage): Promise<void> {
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk as Uint8Array);
    if (size > 0) throw safeError("native_host_control_body_forbidden");
  }
}

function listen(server: Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  assertEvidenceSafe(value);
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function respondError(response: ServerResponse, status: number, code: string): void {
  respondJson(response, status, Object.freeze({ schemaVersion: 1, outcome: "rejected", code }));
}

function validPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function validSecret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 4_096 && !/[\r\n\0]/u.test(value);
}

function requiredTimestamp(value: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw safeError("native_host_timestamp_invalid");
  }
  return value;
}

function requiredSafeText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) {
    throw safeError("native_host_safe_text_invalid");
  }
  return value;
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sameNumbers(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function safeCode(error: unknown, fallback: string): string {
  const source = error instanceof Error ? error.message : "";
  return /^native_host_[a-z0-9_]{2,128}$/u.test(source) ? source : fallback;
}

function safeError(code: string): Error {
  return new Error(code);
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}
