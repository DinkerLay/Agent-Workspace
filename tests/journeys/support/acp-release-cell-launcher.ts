import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAcpProductionConfiguration,
  type AcpProductionConfiguration,
} from "../../../apps/runtime-host/src/acp-production-configuration.js";
import { productionArtifactDigest } from "../../../scripts/production-release-artifact.mjs";
import { startProductionWorkbenchServer } from "../../../scripts/production-workbench-server.mjs";
import type { AcpReleaseAttestorIssuer } from "../acp-release-attestation.js";
import type { NativeReleaseIdentity } from "./native-unified-host-service.js";

const LOOPBACK_HOST = "127.0.0.1";
const CANONICAL_USER_ID = "user_local";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const NATIVE_HOST_CLI = path.join(
  REPOSITORY_ROOT,
  "tests",
  "journeys",
  "support",
  "native-unified-host-service-cli.ts",
);
const TSX_CLI = path.join(REPOSITORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ELECTRON_MAIN = path.join(REPOSITORY_ROOT, "apps", "desktop", "main.cjs");
const WORKBENCH_BUILD = path.join(REPOSITORY_ROOT, "dist", "workbench", "index.html");
const RESTART_EXIT_CODE = 75;
const READY_TIMEOUT_MS = 900_000;
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const SAFE_TEXT = /^[^\s\u0000-\u001f\u007f]{1,160}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const TASK_WORKSPACE_DIRECTORY_ENV = "AGENT_WORKSPACE_RELEASE_TASK_WORKSPACE_DIRECTORY";

export const ACP_RELEASE_CELL_LAUNCHERS = Object.freeze({
  "cell_opencode-acp-task": Object.freeze({
    scenarioId: "scenario_opencode-acp-task",
    issuer: "opencode_acp_task_attestor",
    kind: "task",
    attestationPath: "/evidence/acp-provider",
    providerFamily: "opencode",
  }),
  "cell_codex-acp-task": Object.freeze({
    scenarioId: "scenario_codex-acp-task",
    issuer: "codex_acp_task_attestor",
    kind: "task",
    attestationPath: "/evidence/acp-provider",
    providerFamily: "codex",
  }),
  "cell_acp-meta": Object.freeze({
    scenarioId: "scenario_acp-meta",
    issuer: "acp_meta_attestor",
    kind: "meta",
    attestationPath: "/evidence/acp-meta",
  }),
} as const);

export const ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS = Object.freeze({
  "cell_opencode-acp-task": "AGENT_WORKSPACE_RELEASE_OPENCODE_ACP_TASK_HOST_ENVIRONMENT",
  "cell_codex-acp-task": "AGENT_WORKSPACE_RELEASE_CODEX_ACP_TASK_HOST_ENVIRONMENT",
  "cell_acp-meta": "AGENT_WORKSPACE_RELEASE_ACP_META_HOST_ENVIRONMENT",
} as const);

export type AcpReleaseCellId = keyof typeof ACP_RELEASE_CELL_LAUNCHERS;
export type AcpReleaseCellLauncherDescriptor = typeof ACP_RELEASE_CELL_LAUNCHERS[AcpReleaseCellId];

export type AcpReleaseHostEnvironmentEnvelope = Readonly<{
  schemaVersion: 1;
  issuer: AcpReleaseAttestorIssuer;
  /** Parent-authorized real Workspace. Never an ACP process cwd. */
  workspaceDirectory: string;
  hostEnvironment: Readonly<Record<string, string>>;
  taskModel?: string;
  metaProfileOptionId?: string;
}>;

export type AcpNativeHostReady = Readonly<{
  type: "native_unified_host_ready";
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
  issuer: AcpReleaseAttestorIssuer;
}>;

export type AcpReleaseCellManifest = Readonly<{
  schemaVersion: 1;
  kind: "acp_release_cell";
  issuer: AcpReleaseAttestorIssuer;
  browserUrl: string;
  hostLedgerUrl: string;
  operationLedgerUrl: string;
  observedLineageUrl: string;
  healthUrl: string;
  attestationLedgerUrl: string;
  unavailableAttestationLedgerUrl: string;
  runtimeInstanceId: string;
  lineageId: string;
  restartExecutable: string;
  actionEvidenceFile: string;
  electronEnvironmentFile: string;
  runnerEnvironmentFile: string;
  electronMain: string;
  workbenchBuild: string;
  buildDigest: string;
}>;

export class AcpReleaseCellLauncherBlockedError extends Error {}

type NativeGenerationHandle = Readonly<{
  ready: AcpNativeHostReady;
  exited: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  terminate(): Promise<void>;
}>;

export type AcpNativeGenerationSupervisor = Readonly<{
  start(): Promise<AcpNativeHostReady>;
  waitForGeneration(generation: number): Promise<AcpNativeHostReady>;
  close(): Promise<void>;
}>;

/**
 * Cross-process generation owner. A restart is accepted only when the prior
 * child has exited with the dedicated code; only then is generation+1
 * constructed against the same state root, Runtime database, and fixed ports.
 */
export function createAcpNativeGenerationSupervisor(input: Readonly<{
  startGeneration(generation: number): Promise<NativeGenerationHandle>;
}>): AcpNativeGenerationSupervisor {
  let current: NativeGenerationHandle | undefined;
  let generation = 0;
  let closing = false;
  let failure: unknown;
  let launchQueue: Promise<AcpNativeHostReady> | undefined;
  const waiters = new Map<number, Readonly<{
    resolve(value: AcpNativeHostReady): void;
    reject(error: unknown): void;
  }>>();

  return Object.freeze({
    start: () => launch(1),
    waitForGeneration(target) {
      if (!Number.isSafeInteger(target) || target < 1) {
        return Promise.reject(new Error("acp_release_generation_invalid"));
      }
      if (failure) return Promise.reject(failure);
      if (current?.ready.generation === target) return Promise.resolve(current.ready);
      if (target <= generation) return Promise.reject(new Error("acp_release_generation_not_current"));
      return new Promise<AcpNativeHostReady>((resolve, reject) => {
        if (waiters.has(target)) return reject(new Error("acp_release_generation_waiter_duplicate"));
        waiters.set(target, Object.freeze({ resolve, reject }));
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const waiter of waiters.values()) waiter.reject(new Error("acp_release_launcher_closed"));
      waiters.clear();
      await current?.terminate();
      current = undefined;
    },
  });

  function launch(target: number): Promise<AcpNativeHostReady> {
    if (closing) return Promise.reject(new Error("acp_release_launcher_closed"));
    if (failure) return Promise.reject(failure);
    if (current?.ready.generation === target) return Promise.resolve(current.ready);
    if (launchQueue) return launchQueue;
    launchQueue = input.startGeneration(target).then((handle) => {
      if (handle.ready.generation !== target) throw new Error("acp_release_generation_ready_mismatch");
      current = handle;
      generation = target;
      waiters.get(target)?.resolve(handle.ready);
      waiters.delete(target);
      void monitor(handle, target);
      return handle.ready;
    }).catch((error: unknown) => {
      fail(error);
      throw error;
    }).finally(() => {
      launchQueue = undefined;
    });
    return launchQueue;
  }

  async function monitor(handle: NativeGenerationHandle, observedGeneration: number): Promise<void> {
    const result = await handle.exited.catch((error: unknown) => {
      fail(error);
      return undefined;
    });
    if (!result || closing || current !== handle) return;
    current = undefined;
    if (result.code !== RESTART_EXIT_CODE || result.signal !== null) {
      fail(new Error("acp_release_native_host_unexpected_exit"));
      return;
    }
    await launch(observedGeneration + 1).catch(() => undefined);
  }

  function fail(error: unknown): void {
    if (failure || closing) return;
    failure = error instanceof Error ? error : new Error("acp_release_generation_failed");
    for (const waiter of waiters.values()) waiter.reject(failure);
    waiters.clear();
  }
}

export function validateAcpReleaseHostEnvironmentEnvelope(
  value: unknown,
  expectedIssuer: AcpReleaseAttestorIssuer,
): AcpReleaseHostEnvironmentEnvelope {
  if (!isRecord(value)) throw blocked("acp_release_host_environment_invalid");
  const taskLane = expectedIssuer !== "acp_meta_attestor";
  const allowed = taskLane
    ? ["schemaVersion", "issuer", "workspaceDirectory", "hostEnvironment", "taskModel"]
    : ["schemaVersion", "issuer", "workspaceDirectory", "hostEnvironment", "metaProfileOptionId"];
  if (!sameKeys(value, allowed)
    || value.schemaVersion !== 1
    || value.issuer !== expectedIssuer
    || typeof value.workspaceDirectory !== "string"
    || !path.isAbsolute(value.workspaceDirectory)
    || path.normalize(value.workspaceDirectory) !== value.workspaceDirectory
    || value.workspaceDirectory.includes("\0")
    || !isRecord(value.hostEnvironment)) {
    throw blocked("acp_release_host_environment_invalid");
  }
  const serializedConfiguration = value.hostEnvironment.AGENT_WORKSPACE_ACP_CONFIG;
  if (typeof serializedConfiguration !== "string" || serializedConfiguration.length > 128 * 1024) {
    throw blocked("acp_release_host_environment_invalid");
  }
  let configuration: AcpProductionConfiguration;
  try {
    configuration = parseAcpProductionConfiguration(serializedConfiguration);
  } catch {
    throw blocked("acp_release_host_environment_invalid");
  }
  const expectedReferences = new Set<string>([
    "AGENT_WORKSPACE_ACP_CONFIG",
    ...configurationEnvironmentReferences(configuration),
  ]);
  const observedKeys = Object.keys(value.hostEnvironment);
  if (observedKeys.length !== expectedReferences.size
    || observedKeys.some((key) => !expectedReferences.has(key))
    || observedKeys.some((key) => !SAFE_ENVIRONMENT_NAME.test(key) || reservedEnvironmentName(key))) {
    throw blocked("acp_release_host_environment_invalid");
  }
  for (const [key, entry] of Object.entries(value.hostEnvironment)) {
    const limit = key === "AGENT_WORKSPACE_ACP_CONFIG" ? 128 * 1024 : 8_192;
    if (typeof entry !== "string" || !entry.trim() || entry.length > limit || /[\r\n\0]/u.test(entry)) {
      throw blocked("acp_release_host_environment_invalid");
    }
  }
  const configuredAgents = Object.keys(configuration.agents);
  if (taskLane) {
    const providerFamily = expectedIssuer === "opencode_acp_task_attestor" ? "opencode" : "codex";
    if (configuredAgents.length !== 1 || configuredAgents[0] !== providerFamily
      || configuration.metaProfiles.length !== 0
      || typeof value.taskModel !== "string" || !SAFE_TEXT.test(value.taskModel)) {
      throw blocked("acp_release_host_environment_lane_mismatch");
    }
  } else {
    const optionId = typeof value.metaProfileOptionId === "string" ? value.metaProfileOptionId : "";
    const profile = configuration.metaProfiles.find((entry) => entry.metaProfileOptionId === optionId);
    if (configuration.metaProfiles.length !== 1 || !profile
      || configuredAgents.length !== 1 || configuredAgents[0] !== profile.profile.providerFamily) {
      throw blocked("acp_release_host_environment_lane_mismatch");
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    issuer: expectedIssuer,
    workspaceDirectory: value.workspaceDirectory,
    hostEnvironment: Object.freeze({ ...value.hostEnvironment }) as Readonly<Record<string, string>>,
    ...(taskLane ? { taskModel: value.taskModel as string } : { metaProfileOptionId: value.metaProfileOptionId as string }),
  });
}

export async function startAcpReleaseCellLauncher(input: Readonly<{
  stateRoot: string;
  manifestPath: string;
  releaseIdentity: NativeReleaseIdentity;
  hostEnvironment: AcpReleaseHostEnvironmentEnvelope;
  expectedBuildDigest: string;
  /** One-shot exact lane revalidation, called immediately before first local write/Host effect. */
  consumeHostInputSealBeforeFirstEffect(): Promise<void>;
  environment?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{
  manifest: AcpReleaseCellManifest;
  close(): Promise<void>;
}>> {
  const descriptor = launcherDescriptor(input.releaseIdentity.bundleCellId, input.releaseIdentity.scenarioId);
  if (descriptor.issuer !== input.releaseIdentity.issuer || descriptor.issuer !== input.hostEnvironment.issuer) {
    throw blocked("acp_release_launcher_identity_mismatch");
  }
  if (!SHA256.test(input.expectedBuildDigest)) throw blocked("acp_release_build_digest_invalid");
  const stateRoot = await requirePrivateDirectory(input.stateRoot, "acp_release_state_root_invalid");
  const manifestPath = requireAbsolute(input.manifestPath, "acp_release_manifest_path_invalid");
  if (path.dirname(manifestPath) !== stateRoot) throw blocked("acp_release_manifest_path_invalid");
  const observedBuildDigest = await productionArtifactDigest(REPOSITORY_ROOT);
  if (observedBuildDigest !== input.expectedBuildDigest) throw blocked("acp_release_build_digest_drift");
  if (typeof input.consumeHostInputSealBeforeFirstEffect !== "function") {
    throw blocked("acp_release_host_input_seal_missing");
  }
  await input.consumeHostInputSealBeforeFirstEffect();

  const runtimeDataDirectory = path.join(stateRoot, "runtime-data");
  await mkdir(runtimeDataDirectory, { mode: 0o700 });
  await chmod(runtimeDataDirectory, 0o700);
  const identityFile = path.join(stateRoot, "release-identity.json");
  await writePrivateJson(identityFile, input.releaseIdentity);
  const [browserPort, bridgePort, servicePort] = await Promise.all([
    reserveLoopbackPort(), reserveLoopbackPort(), reserveLoopbackPort(),
  ]);
  if (new Set([browserPort, bridgePort, servicePort]).size !== 3) {
    throw new Error("acp_release_port_collision");
  }
  const browserUrl = `http://${LOOPBACK_HOST}:${browserPort}/`;
  const rendererToken = secret();
  const desktopRendererToken = secret();
  const evidenceToken = secret();
  const controlToken = secret();
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyText = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const sourceEnvironment = input.environment ?? process.env;
  let activeReady: AcpNativeHostReady | undefined;

  const supervisor = createAcpNativeGenerationSupervisor({
    startGeneration: async (generation) => {
      const hostEpoch = `host_epoch_release_${generation}_${randomBytes(18).toString("base64url")}`;
      const child = spawn(process.execPath, [
        TSX_CLI,
        NATIVE_HOST_CLI,
        "--state-root", stateRoot,
        "--runtime-data", runtimeDataDirectory,
        "--bridge-port", String(bridgePort),
        "--service-port", String(servicePort),
        "--generation", String(generation),
        "--allowed-origin", browserUrl,
        "--identity", identityFile,
      ], {
        cwd: REPOSITORY_ROOT,
        env: {
          ...narrowSystemEnvironment(sourceEnvironment),
          ...input.hostEnvironment.hostEnvironment,
          NODE_NO_WARNINGS: "1",
          AGENT_WORKSPACE_OWNER_ID: CANONICAL_USER_ID,
          AGENT_WORKSPACE_NATIVE_RENDERER_TOKEN: rendererToken,
          AGENT_WORKSPACE_NATIVE_DESKTOP_RENDERER_TOKEN: desktopRendererToken,
          AGENT_WORKSPACE_NATIVE_EVIDENCE_TOKEN: evidenceToken,
          AGENT_WORKSPACE_NATIVE_CONTROL_TOKEN: controlToken,
          AGENT_WORKSPACE_ACP_HOST_EPOCH: hostEpoch,
          AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKeyText,
          ...(descriptor.kind === "task"
            ? { [TASK_WORKSPACE_DIRECTORY_ENV]: input.hostEnvironment.workspaceDirectory }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const ready = await waitForNativeReady(child, input.releaseIdentity, generation, bridgePort, servicePort);
      activeReady = ready;
      const exited = childExit(child);
      return Object.freeze({
        ready,
        exited,
        terminate: () => terminateChild(child),
      });
    },
  });

  let workbench: Awaited<ReturnType<typeof startProductionWorkbenchServer>> | undefined;
  try {
    const ready = await supervisor.start();
    workbench = await startProductionWorkbenchServer({
      repositoryRoot: REPOSITORY_ROOT,
      host: LOOPBACK_HOST,
      port: browserPort,
      runtimeUrl: ready.runtimeUrl,
      rendererToken,
      ownerId: CANONICAL_USER_ID,
    });
    if (workbench.url !== browserUrl) throw new Error("acp_release_browser_url_mismatch");

    const controlFile = path.join(stateRoot, "restart-control.json");
    await writePrivateJson(controlFile, {
      schemaVersion: 1,
      serviceUrl: ready.serviceUrl,
      controlToken,
      runtimeInstanceId: input.releaseIdentity.runtimeInstanceId,
    });
    const restartExecutable = path.join(stateRoot, "restart-native-acp-host.mjs");
    await writeExecutable(restartExecutable, restartExecutableSource(controlFile));
    const actionEvidenceFile = path.join(stateRoot, "action-evidence.json");
    await writePrivateFile(actionEvidenceFile, "");
    const electronEnvironmentFile = path.join(stateRoot, "electron-environment.json");
    await writePrivateJson(electronEnvironmentFile, {
      AGENT_WORKSPACE_RUNTIME_URL: ready.runtimeUrl,
      AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: desktopRendererToken,
      AGENT_WORKSPACE_RUNTIME_ORIGIN: new URL(browserUrl).origin,
    });
    const runnerEnvironmentFile = path.join(stateRoot, "runner-environment.json");
    await writePrivateJson(runnerEnvironmentFile, {
      AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: evidenceToken,
      ...(descriptor.kind === "task"
        ? {
            AGENT_WORKSPACE_ACP_TASK_PROVIDER_FAMILY: descriptor.providerFamily,
            AGENT_WORKSPACE_ACP_TASK_MODEL: input.hostEnvironment.taskModel,
          }
        : { AGENT_WORKSPACE_ACP_META_PROFILE_OPTION_ID: input.hostEnvironment.metaProfileOptionId }),
      AGENT_WORKSPACE_RELEASE_SCENARIO_ID: input.releaseIdentity.scenarioId,
    });
    const selectedAttestation = descriptor.attestationPath === "/evidence/acp-provider"
      ? ready.nativeProviderLedgerUrl
      : ready.nativeMetaLedgerUrl;
    const unavailableAttestation = descriptor.attestationPath === "/evidence/acp-provider"
      ? ready.nativeMetaLedgerUrl
      : ready.nativeProviderLedgerUrl;
    const manifest = Object.freeze({
      schemaVersion: 1 as const,
      kind: "acp_release_cell" as const,
      issuer: descriptor.issuer,
      browserUrl,
      hostLedgerUrl: ready.hostLedgerUrl,
      operationLedgerUrl: ready.operationLedgerUrl,
      observedLineageUrl: ready.observedLineageUrl,
      healthUrl: ready.healthUrl,
      attestationLedgerUrl: selectedAttestation,
      unavailableAttestationLedgerUrl: unavailableAttestation,
      runtimeInstanceId: ready.runtimeInstanceId,
      lineageId: ready.lineageId,
      restartExecutable,
      actionEvidenceFile,
      electronEnvironmentFile,
      runnerEnvironmentFile,
      electronMain: ELECTRON_MAIN,
      workbenchBuild: WORKBENCH_BUILD,
      buildDigest: input.expectedBuildDigest,
    });
    await writePrivateJson(manifestPath, manifest);
    return Object.freeze({
      manifest,
      async close() {
        await workbench?.close();
        workbench = undefined;
        const serviceUrl = activeReady?.serviceUrl;
        if (serviceUrl) {
          await fetch(`${serviceUrl}/control/shutdown`, {
            method: "POST",
            headers: { authorization: `Bearer ${controlToken}` },
          }).catch(() => undefined);
        }
        await supervisor.close();
      },
    });
  } catch (error) {
    await workbench?.close().catch(() => undefined);
    await supervisor.close().catch(() => undefined);
    throw error;
  }
}

export function launcherDescriptor(bundleCellId: string, scenarioId: string): AcpReleaseCellLauncherDescriptor {
  if (!(bundleCellId in ACP_RELEASE_CELL_LAUNCHERS)) throw blocked("acp_release_launcher_cell_invalid");
  const descriptor = ACP_RELEASE_CELL_LAUNCHERS[bundleCellId as AcpReleaseCellId];
  if (descriptor.scenarioId !== scenarioId) throw blocked("acp_release_launcher_scenario_invalid");
  return descriptor;
}

function configurationEnvironmentReferences(configuration: AcpProductionConfiguration): readonly string[] {
  const references: string[] = [];
  const openCode = configuration.agents.opencode;
  if (openCode) references.push(openCode.command.env, openCode.executableSearchPath.env, openCode.authFile.env);
  const codex = configuration.agents.codex;
  if (codex) references.push(
    codex.wrapperCommand.env,
    codex.codexCommand.env,
    codex.nodeCommand.env,
    codex.executableSearchPath.env,
    codex.authFile.env,
  );
  return Object.freeze([...new Set(references)]);
}

function reservedEnvironmentName(value: string): boolean {
  return value === "AGENT_WORKSPACE_ACP_CONFIG"
    ? false
    : value === "AGENT_WORKSPACE_OWNER_ID"
      || value.startsWith("AGENT_WORKSPACE_NATIVE_")
      || value.startsWith("AGENT_WORKSPACE_ACP_HOST_EPOCH")
      || value === "NODE_OPTIONS"
      || value === "ELECTRON_RUN_AS_NODE";
}

async function waitForNativeReady(
  child: ChildProcess,
  identity: NativeReleaseIdentity,
  generation: number,
  bridgePort: number,
  servicePort: number,
): Promise<AcpNativeHostReady> {
  if (!child.stdout || !child.stderr) throw new Error("acp_release_native_host_stdio_missing");
  const stdout = child.stdout;
  const stderr = child.stderr;
  return new Promise<AcpNativeHostReady>((resolve, reject) => {
    let buffer = "";
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("acp_release_native_host_ready_timeout")), READY_TIMEOUT_MS);
    const count = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > OUTPUT_LIMIT_BYTES) finish(new Error("acp_release_native_host_output_limit"));
    };
    stdout.setEncoding("utf8");
    stdout.on("data", onStdout);
    stderr.on("data", count);
    child.once("error", onError);
    child.once("exit", onExit);

    function onStdout(chunk: string): void {
      count(chunk);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { value = undefined; }
        const ready = normalizeNativeReady(value, identity, generation, bridgePort, servicePort);
        if (ready) return finish(undefined, ready);
      }
    }
    function onError(): void { finish(new Error("acp_release_native_host_spawn_failed")); }
    function onExit(): void { finish(new Error("acp_release_native_host_exited_before_ready")); }
    function finish(error?: Error, ready?: AcpNativeHostReady): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.off("data", onStdout);
      stderr.off("data", count);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error || !ready) reject(error ?? new Error("acp_release_native_host_ready_invalid"));
      else resolve(ready);
    }
  });
}

function normalizeNativeReady(
  value: unknown,
  identity: NativeReleaseIdentity,
  generation: number,
  bridgePort: number,
  servicePort: number,
): AcpNativeHostReady | undefined {
  const keys = [
    "type", "runtimeUrl", "serviceUrl", "healthUrl", "hostLedgerUrl", "operationLedgerUrl",
    "observedLineageUrl", "nativeProviderLedgerUrl", "nativeMetaLedgerUrl", "runtimeInstanceId",
    "lineageId", "generation", "issuer",
  ];
  if (!isRecord(value) || !sameKeys(value, keys) || value.type !== "native_unified_host_ready") return undefined;
  if (value.runtimeInstanceId !== identity.runtimeInstanceId || value.issuer !== identity.issuer
    || value.generation !== generation
    || value.lineageId !== `session_id_native_lineage_${identity.runtimeInstanceId}`) {
    throw new Error("acp_release_native_host_ready_identity_invalid");
  }
  const runtimeUrl = exactLoopbackOrigin(value.runtimeUrl, bridgePort, "acp_release_native_runtime_url_invalid");
  const serviceUrl = exactLoopbackOrigin(value.serviceUrl, servicePort, "acp_release_native_service_url_invalid");
  const endpoints = {
    healthUrl: "/health",
    hostLedgerUrl: "/evidence/commands",
    operationLedgerUrl: "/evidence/operations",
    observedLineageUrl: "/evidence/observed-lineage",
    nativeProviderLedgerUrl: "/evidence/acp-provider",
    nativeMetaLedgerUrl: "/evidence/acp-meta",
  } as const;
  for (const [field, suffix] of Object.entries(endpoints)) {
    if (value[field] !== `${serviceUrl}${suffix}`) throw new Error("acp_release_native_evidence_url_invalid");
  }
  return Object.freeze({
    type: "native_unified_host_ready",
    runtimeUrl,
    serviceUrl,
    healthUrl: value.healthUrl as string,
    hostLedgerUrl: value.hostLedgerUrl as string,
    operationLedgerUrl: value.operationLedgerUrl as string,
    observedLineageUrl: value.observedLineageUrl as string,
    nativeProviderLedgerUrl: value.nativeProviderLedgerUrl as string,
    nativeMetaLedgerUrl: value.nativeMetaLedgerUrl as string,
    runtimeInstanceId: value.runtimeInstanceId as string,
    lineageId: value.lineageId as string,
    generation,
    issuer: value.issuer as AcpReleaseAttestorIssuer,
  });
}

function exactLoopbackOrigin(value: unknown, expectedPort: number, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== LOOPBACK_HOST || Number(url.port) !== expectedPort
    || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(code);
  }
  return url.origin;
}

function childExit(child: ChildProcess): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(Object.freeze({ code, signal })));
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    childExit(child).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (exited) return;
  child.kill("SIGKILL");
  await childExit(child).catch(() => undefined);
}

function restartExecutableSource(controlFile: string): string {
  return [
    `#!${process.execPath}`,
    `import { readFile } from "node:fs/promises";`,
    `const control = JSON.parse(await readFile(${JSON.stringify(controlFile)}, "utf8"));`,
    `const before = await fetch(control.serviceUrl + "/health").then((response) => response.json());`,
    `const response = await fetch(control.serviceUrl + "/control/restart", { method: "POST", headers: { authorization: "Bearer " + control.controlToken } });`,
    `if (response.status !== 202) throw new Error("acp_release_restart_not_accepted");`,
    `const accepted = await response.json();`,
    `if (accepted.runtimeInstanceId !== control.runtimeInstanceId || accepted.generation !== before.generation) throw new Error("acp_release_restart_identity_mismatch");`,
    `const deadline = Date.now() + 900000;`,
    `while (Date.now() < deadline) {`,
    `  try {`,
    `    const next = await fetch(control.serviceUrl + "/health").then((candidate) => candidate.ok ? candidate.json() : undefined);`,
    `    if (next?.runtimeInstanceId === control.runtimeInstanceId && next.generation === before.generation + 1) process.exit(0);`,
    `  } catch {}`,
    `  await new Promise((resolve) => setTimeout(resolve, 100));`,
    `}`,
    `throw new Error("acp_release_restart_generation_timeout");`,
    "",
  ].join("\n");
}

function narrowSystemEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "SSL_CERT_DIR", "SSL_CERT_FILE", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
  ] as const) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error || !Number.isSafeInteger(port) || !port) reject(error ?? new Error("acp_release_port_invalid"));
        else resolve(port);
      });
    });
  });
}

async function requirePrivateDirectory(value: string, code: string): Promise<string> {
  const absolute = requireAbsolute(value, code);
  const metadata = await lstat(absolute).catch(() => undefined);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()
    || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    || await realpath(absolute) !== absolute) {
    throw blocked(code);
  }
  return absolute;
}

function requireAbsolute(value: string, code: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw blocked(code);
  return path.resolve(value);
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writePrivateFile(file, `${JSON.stringify(value)}\n`);
}

async function writePrivateFile(file: string, value: string): Promise<void> {
  await writeFile(file, value, { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
}

async function writeExecutable(file: string, value: string): Promise<void> {
  await writeFile(file, value, { mode: 0o700, flag: "wx" });
  await chmod(file, 0o700);
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function sameKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function blocked(code: string): AcpReleaseCellLauncherBlockedError {
  return new AcpReleaseCellLauncherBlockedError(code);
}
