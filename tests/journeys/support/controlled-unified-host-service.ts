import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  createSessionIdUnifiedRuntimeBridgeServer,
  type SessionIdUnifiedRuntimeBridgeServer,
} from "../../../apps/runtime-host/src/session-id-unified-runtime-bridge.js";
import {
  createSessionIdUnifiedRuntimeHost,
  type SessionIdUnifiedRuntimeHost,
} from "../../../apps/runtime-host/src/session-id-unified-runtime-host.js";
import {
  CONTROLLED_PROVIDER_STAGES,
  createControlledSessionIdJourneyAcpOwner,
  type ControlledJourneyHostOperation,
  type ControlledJourneyCellMode,
  type ControlledProviderStage,
  normalizeControlledJourneyCellMode,
} from "./controlled-session-id-acp-owner.js";

const LOOPBACK_HOST = "127.0.0.1";
const WORKSPACE_ID = "workspace_journey";
const WORKSPACE_BOOTSTRAP_COMMAND_ID = "controlled-journey-workspace-bootstrap-v1";

export const CONTROLLED_UNIFIED_HOST_PATHS = Object.freeze({
  health: "/health",
  commandLedger: "/evidence/commands",
  operationLedger: "/evidence/operations",
  observedLineage: "/evidence/observed-lineage",
  restart: "/control/restart",
  shutdown: "/control/shutdown",
  providerClockPrefix: "/control/provider-clock/",
});

export type ControlledUnifiedHostServiceOptions = Readonly<{
  stateRoot: string;
  rendererToken: string;
  desktopRendererToken: string;
  evidenceToken: string;
  controlToken: string;
  allowedOrigins: readonly string[];
  authenticatedUserId?: string;
  bridgePort?: number;
  servicePort?: number;
  dispatchIntervalMs?: number;
  cellMode?: ControlledJourneyCellMode;
  /** Release-matrix Runtime anchor frozen before this fresh Host process starts. */
  expectedLineage?: ControlledExpectedLineage;
  now?: () => string;
}>;

export type ControlledExpectedLineage = Readonly<{
  runtimeInstanceId: string;
}>;

export type ControlledUnifiedHostService = Readonly<{
  stateRoot: string;
  workspaceRoot: string;
  databasePath: string;
  operationLedgerFile: string;
  runtimeUrl: string;
  serviceUrl: string;
  healthUrl: string;
  hostLedgerUrl: string;
  operationLedgerUrl: string;
  observedLineageUrl: string;
  runtimeInstanceId: string;
  lineageId: string;
  generation: number;
  providerClock: ReturnType<ReturnType<typeof createControlledSessionIdJourneyAcpOwner>["clock"]["snapshot"]>;
  restart(): Promise<Readonly<{ runtimeInstanceId: string; lineageId: string; generation: number }>>;
  releaseProviderStage(stage: ControlledProviderStage): Promise<Readonly<{ status: "released" | "replayed" }>>;
  close(): Promise<void>;
}>;

/**
 * Starts the real unified Runtime Host and Bridge behind a loopback-only
 * journey service. The public evidence endpoints are bounded read models;
 * restart, shutdown, and Provider-clock advancement require a separate
 * control secret that is never a Runtime/Bridge credential.
 */
export async function startControlledUnifiedHostService(
  options: ControlledUnifiedHostServiceOptions,
): Promise<ControlledUnifiedHostService> {
  const stateRoot = requiredAbsolute(options.stateRoot, "controlled_host_state_root_absolute_required");
  const workspaceRoot = path.join(stateRoot, "workspace");
  const databasePath = path.join(stateRoot, "runtime.sqlite");
  const operationLedgerFile = path.join(stateRoot, "host-operation-ledger.jsonl");
  const now = options.now ?? (() => new Date().toISOString());
  const authenticatedUserId = requiredText(options.authenticatedUserId ?? "user_local", "controlled_host_user_required");
  const rendererToken = requiredSecret(options.rendererToken, "controlled_host_renderer_token_required");
  const desktopRendererToken = requiredSecret(options.desktopRendererToken, "controlled_host_desktop_token_required");
  const evidenceToken = requiredSecret(options.evidenceToken, "controlled_host_evidence_token_required");
  const controlToken = requiredSecret(options.controlToken, "controlled_host_control_token_required");
  if (new Set([rendererToken, desktopRendererToken, evidenceToken, controlToken]).size !== 4) {
    throw new Error("controlled_host_tokens_must_differ");
  }
  const allowedOrigins = Object.freeze(options.allowedOrigins.map((origin) => normalizedOrigin(origin)));
  if (allowedOrigins.length === 0) throw new Error("controlled_host_allowed_origin_required");
  const requestedBridgePort = validPort(options.bridgePort ?? 0, "controlled_host_bridge_port_invalid", true);
  const requestedServicePort = validPort(options.servicePort ?? 0, "controlled_host_service_port_invalid", true);
  const expectedLineage = options.expectedLineage === undefined
    ? undefined
    : normalizeControlledExpectedLineage(options.expectedLineage);
  const expectedRuntimeInstanceId = expectedLineage?.runtimeInstanceId;
  const cellMode = normalizeControlledJourneyCellMode(options.cellMode ?? "main");
  const createHostId = createExpectedLineageIdAllocator(expectedLineage);

  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await chmod(workspaceRoot, 0o700);
  await writeFile(operationLedgerFile, "", { flag: "a", mode: 0o600 });
  await chmod(operationLedgerFile, 0o600);

  let host: SessionIdUnifiedRuntimeHost | undefined;
  let bridge: SessionIdUnifiedRuntimeBridgeServer | undefined;
  let runtimeUrl = "";
  let bridgePort = requestedBridgePort;
  let runtimeInstanceId = expectedRuntimeInstanceId ?? "";
  let lineageId = expectedRuntimeInstanceId ? `session_id_controlled_lineage_${expectedRuntimeInstanceId}` : "";
  let generation = 0;
  let ready = false;
  let closed = false;
  let restarting: Promise<Readonly<{ runtimeInstanceId: string; lineageId: string; generation: number }>> | undefined;
  let fatalFailure: string | undefined;
  let cachedCommandLedger: ReturnType<SessionIdUnifiedRuntimeHost["readCommandEvidence"]> = Object.freeze([]);
  let operationSequence = 0;
  let operationWrite: Promise<void> = Promise.resolve();

  const operations: Array<Readonly<Record<string, unknown>>> = [];
  const ports = createControlledSessionIdJourneyAcpOwner({
    cellMode,
    now,
    recordOperation,
    onFatal(error) {
      fatalFailure = safeCode(error, "controlled_provider_background_failed");
    },
  });

  await openHost();
  const serviceServer = createServer((request, response) => {
    void handleServiceRequest(request, response).catch((error: unknown) => {
      respondError(response, 500, safeCode(error, "controlled_host_service_failed"));
    });
  });
  const serviceAddress = await listen(serviceServer, requestedServicePort);
  const serviceUrl = `http://${LOOPBACK_HOST}:${serviceAddress.port}`;

  const service: ControlledUnifiedHostService = Object.freeze({
    stateRoot,
    workspaceRoot,
    databasePath,
    operationLedgerFile,
    get runtimeUrl() { return runtimeUrl; },
    serviceUrl,
    healthUrl: `${serviceUrl}${CONTROLLED_UNIFIED_HOST_PATHS.health}`,
    hostLedgerUrl: `${serviceUrl}${CONTROLLED_UNIFIED_HOST_PATHS.commandLedger}`,
    operationLedgerUrl: `${serviceUrl}${CONTROLLED_UNIFIED_HOST_PATHS.operationLedger}`,
    observedLineageUrl: `${serviceUrl}${CONTROLLED_UNIFIED_HOST_PATHS.observedLineage}`,
    get runtimeInstanceId() { return runtimeInstanceId; },
    get lineageId() { return lineageId; },
    get generation() { return generation; },
    get providerClock() { return ports.clock.snapshot(); },
    restart,
    releaseProviderStage: (stage) => ports.clock.release(stage),
    close,
  });
  return service;

  async function openHost(): Promise<void> {
    if (closed) throw new Error("controlled_host_service_closed");
    fatalFailure = undefined;
    const nextHost = await createSessionIdUnifiedRuntimeHost({
      databasePath,
      authenticatedUserId,
      workspaceBootstrapGrants: Object.freeze([Object.freeze({
        commandId: WORKSPACE_BOOTSTRAP_COMMAND_ID,
        workspaceId: WORKSPACE_ID,
        directory: workspaceRoot,
        displayName: "Journey Workspace",
      })]),
      createProviderOwner: (input) => ports.createProviderOwner(input),
      authorizeRetiringBindingRecovery: () => false,
      dispatchIntervalMs: options.dispatchIntervalMs ?? 250,
      now,
      createId: createHostId,
      onDiagnostic(diagnostic) {
        if (diagnostic.code.endsWith("_failed")) fatalFailure = diagnostic.code;
      },
    });
    const nextBridge = createSessionIdUnifiedRuntimeBridgeServer({
      host: nextHost,
      rendererToken,
      desktopRendererToken,
      evidenceToken,
      allowedOrigins,
      authorizeTask: () => true,
      authorizeCommand(command, userId) {
        return !("ownerId" in command) || command.ownerId === userId;
      },
    });
    try {
      const address = await nextBridge.listen(bridgePort, LOOPBACK_HOST);
      bridgePort = address.port;
      runtimeUrl = address.url;
      if (expectedRuntimeInstanceId && nextHost.runtimeInstanceId !== expectedRuntimeInstanceId) {
        throw new Error("controlled_host_runtime_instance_mismatch");
      }
      if (runtimeInstanceId && nextHost.runtimeInstanceId !== runtimeInstanceId) {
        throw new Error("controlled_host_runtime_instance_changed_on_restart");
      }
      runtimeInstanceId = nextHost.runtimeInstanceId;
      lineageId = `session_id_controlled_lineage_${runtimeInstanceId}`;
      generation += 1;
      host = nextHost;
      bridge = nextBridge;
      cachedCommandLedger = nextHost.readCommandEvidence();
      ready = true;
      await appendServiceOperation("host_generation_ready", { generation });
    } catch (error) {
      await nextBridge.close().catch(() => undefined);
      await nextHost.close().catch(() => undefined);
      throw error;
    }
  }

  async function restart(): Promise<Readonly<{ runtimeInstanceId: string; lineageId: string; generation: number }>> {
    if (closed) throw new Error("controlled_host_service_closed");
    if (restarting) return restarting;
    restarting = (async () => {
      const resumeBranch = generation === 1 && cellMode !== "main" && cellMode !== "j08-late-final";
      if (resumeBranch) {
        await ports.awaitHostRestartPoint();
        // The Provider state is already frozen at the declared crash point.
        // Let the semantic invalidation which exposed that state finish its
        // read-only Renderer refresh before closing the old HTTP bridge.
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
      ready = false;
      cachedCommandLedger = host?.readCommandEvidence() ?? cachedCommandLedger;
      const priorRuntimeInstanceId = runtimeInstanceId;
      await appendServiceOperation("host_restart_requested", { generation });
      const priorBridge = bridge;
      const priorHost = host;
      bridge = undefined;
      host = undefined;
      await priorBridge?.close();
      await priorHost?.close();
      if (resumeBranch) await ports.resumeAfterHostRestart();
      await openHost();
      if (runtimeInstanceId !== priorRuntimeInstanceId) throw new Error("controlled_host_restart_lineage_changed");
      await appendServiceOperation("host_restart_completed", { generation });
      return Object.freeze({ runtimeInstanceId, lineageId, generation });
    })().finally(() => { restarting = undefined; });
    return restarting;
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    ready = false;
    const priorBridge = bridge;
    const priorHost = host;
    bridge = undefined;
    host = undefined;
    cachedCommandLedger = priorHost?.readCommandEvidence() ?? cachedCommandLedger;
    await priorBridge?.close().catch(() => undefined);
    await priorHost?.close().catch(() => undefined);
    if (serviceServer.listening) {
      await new Promise<void>((resolve, reject) => serviceServer.close((error) => error ? reject(error) : resolve()));
    }
    await operationWrite;
  }

  async function handleServiceRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = requestTarget(request);
    if (request.method === "GET" && target.pathname === CONTROLLED_UNIFIED_HOST_PATHS.health) {
      return respondJson(response, 200, Object.freeze({
        ready: ready && !fatalFailure,
        runtimeInstanceId,
        lineageId,
        generation,
        cellMode,
        providerClock: ports.clock.snapshot(),
        providerState: ports.snapshot(),
        ...(fatalFailure ? { failureCode: fatalFailure } : {}),
      }));
    }
    if (request.method === "GET" && target.pathname === CONTROLLED_UNIFIED_HOST_PATHS.commandLedger) {
      if (!authorizedBearer(request, evidenceToken)) {
        return respondError(response, 401, "controlled_host_evidence_unauthorized");
      }
      const value = ready && host ? host.readCommandEvidence() : cachedCommandLedger;
      cachedCommandLedger = value;
      return respondJson(response, 200, value);
    }
    if (request.method === "GET" && target.pathname === CONTROLLED_UNIFIED_HOST_PATHS.operationLedger) {
      if (!authorizedBearer(request, evidenceToken)) {
        return respondError(response, 401, "controlled_host_evidence_unauthorized");
      }
      return respondJson(response, 200, Object.freeze([...operations]));
    }
    if (request.method === "GET" && target.pathname === CONTROLLED_UNIFIED_HOST_PATHS.observedLineage) {
      if (!authorizedBearer(request, evidenceToken)) {
        return respondError(response, 401, "controlled_host_evidence_unauthorized");
      }
      if (!ready || !host) return respondError(response, 503, "controlled_host_not_ready");
      return respondJson(response, 200, host.readObservedLineage());
    }
    if (request.method !== "POST") return respondError(response, 404, "controlled_host_endpoint_not_found");
    if (!authorizedBearer(request, controlToken)) return respondError(response, 401, "controlled_host_control_unauthorized");
    await assertEmptyBody(request);
    if (target.pathname === CONTROLLED_UNIFIED_HOST_PATHS.restart) {
      return respondJson(response, 200, await restart());
    }
    if (target.pathname === CONTROLLED_UNIFIED_HOST_PATHS.shutdown) {
      respondJson(response, 202, Object.freeze({ status: "closing" }));
      setImmediate(() => { void close(); });
      return;
    }
    if (target.pathname.startsWith(CONTROLLED_UNIFIED_HOST_PATHS.providerClockPrefix)) {
      const value = decodeURIComponent(target.pathname.slice(CONTROLLED_UNIFIED_HOST_PATHS.providerClockPrefix.length));
      if (!isProviderStage(value)) return respondError(response, 400, "controlled_provider_stage_invalid");
      return respondJson(response, 200, await ports.clock.release(value));
    }
    return respondError(response, 404, "controlled_host_endpoint_not_found");
  }

  async function recordOperation(operation: ControlledJourneyHostOperation): Promise<void> {
    const entry = Object.freeze({
      schemaVersion: 1,
      evidenceClass: "deterministic_fake",
      issuer: "runtime_host",
      uiClaim: false,
      nativeClaim: false,
      runtimeInstanceId: runtimeInstanceId || "runtime_instance_starting",
      lineageId: lineageId || "session_id_controlled_lineage_starting",
      generation,
      sequence: ++operationSequence,
      ...operation,
    });
    operations.push(entry);
    operationWrite = operationWrite.then(async () => {
      await appendFile(operationLedgerFile, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(operationLedgerFile, 0o600);
    });
    await operationWrite;
  }

  function appendServiceOperation(kind: string, extra: Readonly<Record<string, unknown>>): Promise<void> {
    return recordOperation(Object.freeze({
      kind: kind as ControlledJourneyHostOperation["kind"],
      observedAt: now(),
      ...extra,
    }) as ControlledJourneyHostOperation);
  }
}

function requestTarget(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
}

function authorizedBearer(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  const supplied = typeof value === "string" && value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function assertEmptyBody(request: IncomingMessage): Promise<void> {
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 0) throw new Error("controlled_host_control_body_forbidden");
  }
}

function listen(server: Server, port: number): Promise<AddressInfo> {
  return new Promise<AddressInfo>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function respondError(response: ServerResponse, status: number, code: string): void {
  respondJson(response, status, Object.freeze({ error: Object.freeze({ code }) }));
}

function validPort(value: number, code: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 65_535) throw new Error(code);
  return value;
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("controlled_host_allowed_origin_invalid");
  }
  return url.origin;
}

function requiredAbsolute(value: string, code: string): string {
  const normalized = requiredText(value, code);
  if (!path.isAbsolute(normalized)) throw new Error(code);
  return path.resolve(normalized);
}

function requiredText(value: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function requiredSecret(value: string, code: string): string {
  const normalized = requiredText(value, code);
  if (normalized.length < 16 || /\s/u.test(normalized)) throw new Error(code);
  return normalized;
}

function requiredRuntimeInstanceId(value: string): string {
  const normalized = requiredText(value, "controlled_host_runtime_instance_id_required");
  if (normalized.length > 128 || !/^runtime_instance_[A-Za-z0-9-]+$/u.test(normalized)) {
    throw new Error("controlled_host_runtime_instance_id_invalid");
  }
  return normalized;
}

export function normalizeControlledExpectedLineage(value: unknown): ControlledExpectedLineage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("controlled_host_expected_lineage_invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || Object.keys(record)[0] !== "runtimeInstanceId") {
    throw new Error("controlled_host_expected_lineage_invalid");
  }
  return Object.freeze({
    runtimeInstanceId: requiredRuntimeInstanceId(String(record.runtimeInstanceId ?? "")),
  });
}

function createExpectedLineageIdAllocator(
  lineage: ControlledExpectedLineage | undefined,
): (kind: string) => string {
  const ordinals = new Map<string, number>();
  return (kind: string) => {
    const ordinal = (ordinals.get(kind) ?? 0) + 1;
    ordinals.set(kind, ordinal);
    if (kind === "runtime_instance" && ordinal === 1 && lineage) return lineage.runtimeInstanceId;
    return `${kind}_${randomUUID()}`;
  };
}

function safeCode(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /^[a-z][a-z0-9_]{2,159}$/u.test(value) ? value : fallback;
}

function isProviderStage(value: string): value is ControlledProviderStage {
  return (CONTROLLED_PROVIDER_STAGES as readonly string[]).includes(value);
}
