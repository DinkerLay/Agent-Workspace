import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { sessionIdObservedLineageDigest } from "../../apps/runtime-host/src/session-id-observed-lineage.js";
import {
  FULL_JOURNEY_CHECKPOINTS,
  type FullJourneyCheckpoint,
  type JourneyEvidenceLineage,
} from "../e2e/journey-evidence.js";
import {
  runDeterministicSessionIdJourneyCell,
  type DeterministicSessionIdCellMode,
} from "../e2e/support/session-id-deterministic-bridge-fixture.js";
import type {
  JourneyReleaseCellDeclaration,
  JourneyReleaseMatrix,
  JourneyStreamRequirement,
} from "./evidence-issuers.js";
import {
  verifyActionCommandCorrelation,
  type ActionCommandCorrelation,
  type HostCommandLedgerEntry,
  type JourneyActionTrace,
} from "./locator-action-dsl.js";
import { createRequiredJourneyReleaseMatrix } from "./release-verifier.js";
import { validateAcpReleaseAttestationDocument } from "./acp-release-attestation.js";
import {
  ACP_RELEASE_CELL_LAUNCHERS,
  ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS,
  type AcpReleaseCellId,
  type AcpReleaseCellManifest,
} from "./support/acp-release-cell-launcher.js";
import {
  readFinalizedNativeUnifiedHostAttestation,
  type NativeReleaseIdentity,
} from "./support/native-unified-host-service.js";
import type { ControlledJourneyCellMode } from "./support/controlled-session-id-acp-owner.js";
import { productionArtifactDigest } from "../../scripts/production-release-artifact.mjs";
import { assertProductionReleaseNonBuildDigests } from "../../scripts/production-release-inputs.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTROLLED_LAUNCHER = path.join(REPOSITORY_ROOT, "scripts", "launch-controlled-journey.mjs");
const ACP_RELEASE_LAUNCHER = path.join(
  REPOSITORY_ROOT,
  "tests",
  "journeys",
  "support",
  "acp-release-cell-launcher-cli.ts",
);
const JOURNEY_SUITE_RUNNER = path.join(REPOSITORY_ROOT, "scripts", "run-journey-suite.mjs");
const EXPECTED_ELECTRON_MAIN = path.join(REPOSITORY_ROOT, "apps", "desktop", "main.cjs");
const EXPECTED_WORKBENCH_BUILD = path.join(REPOSITORY_ROOT, "dist", "workbench", "index.html");
const LOOPBACK_FETCH_TIMEOUT_MS = 30_000;
const CHILD_TERMINATION_GRACE_MS = 5_000;
const ACP_EXPECTED_HOST_GENERATIONS = Object.freeze({
  opencode_acp_task_attestor: Object.freeze([1, 2]),
  codex_acp_task_attestor: Object.freeze([1, 2]),
  acp_meta_attestor: Object.freeze([1]),
} as const);
const SAFE_RELEASE_FAILURE_CODE = /^(?:acp_[a-z0-9_]+(?::[a-z0-9_]+)*|codex_[a-z0-9_]+(?::[a-z0-9_]+)*|journey_release_[a-z0-9_]{2,128})$/u;
const SAFE_PROVIDER_FAILURE_CODE_IN_TEXT = /(?:^|[^a-z0-9_])(codex_[a-z0-9_]+(?::[a-z0-9_]+)*)(?=$|[^a-z0-9_])/gu;
const SAFE_BOUNDARY_FAILURE_CODE_IN_TEXT = /(?:^|[^a-z0-9_])((?:acp|journey_release)_[a-z0-9_]{2,128})(?=$|[^a-z0-9_])/gu;

const CELL_NAMES = Object.freeze([
  "bridge-fake-main",
  "bridge-fake-j08-unknown",
  "bridge-fake-j08-late-final",
  "bridge-fake-j10-pending-lane",
  "bridge-fake-j10-tool-result",
  "bridge-fake-j10-provider-accepted",
  "bridge-fake-j10-human-interrupting",
  "bridge-fake-j10-final-before-inbox",
  "browser-controlled-main",
  "browser-controlled-j08-unknown",
  "browser-controlled-j08-late-final",
  "browser-controlled-j10-pending-lane",
  "browser-controlled-j10-tool-result",
  "browser-controlled-j10-provider-accepted",
  "browser-controlled-j10-human-interrupting",
  "browser-controlled-j10-final-before-inbox",
  "electron-controlled-main",
  "electron-controlled-j08-unknown",
  "electron-controlled-j08-late-final",
  "electron-controlled-j10-pending-lane",
  "electron-controlled-j10-tool-result",
  "electron-controlled-j10-provider-accepted",
  "electron-controlled-j10-human-interrupting",
  "electron-controlled-j10-final-before-inbox",
  "cross-surface-continuity",
  "opencode-acp-task",
  "codex-acp-task",
  "acp-meta",
] as const);

type ReleaseCellName = typeof CELL_NAMES[number];
type ReleaseIssuer = JourneyStreamRequirement["issuer"];

const BRIDGE_MODES: Readonly<Record<string, DeterministicSessionIdCellMode>> = Object.freeze({
  "bridge-fake-main": "main",
  "bridge-fake-j08-unknown": "j08-unknown",
  "bridge-fake-j08-late-final": "j08-late-final",
  "bridge-fake-j10-pending-lane": "j10-pending-lane",
  "bridge-fake-j10-tool-result": "j10-tool-result",
  "bridge-fake-j10-provider-accepted": "j10-provider-accepted",
  "bridge-fake-j10-human-interrupting": "j10-human-interrupting",
  "bridge-fake-j10-final-before-inbox": "j10-final-before-inbox",
});

const UI_MAIN_MODES = Object.freeze({
  "browser-controlled-main": "browser",
  "electron-controlled-main": "desktop",
  "cross-surface-continuity": "cross",
} as const);

const UI_BRANCH_MODES = Object.freeze({
  "browser-controlled-j08-unknown": { surface: "browser", cellMode: "j08-unknown" },
  "browser-controlled-j08-late-final": { surface: "browser", cellMode: "j08-late-final" },
  "browser-controlled-j10-pending-lane": { surface: "browser", cellMode: "j10-pending-lane" },
  "browser-controlled-j10-tool-result": { surface: "browser", cellMode: "j10-tool-result" },
  "browser-controlled-j10-provider-accepted": { surface: "browser", cellMode: "j10-provider-accepted" },
  "browser-controlled-j10-human-interrupting": { surface: "browser", cellMode: "j10-human-interrupting" },
  "browser-controlled-j10-final-before-inbox": { surface: "browser", cellMode: "j10-final-before-inbox" },
  "electron-controlled-j08-unknown": { surface: "desktop", cellMode: "j08-unknown" },
  "electron-controlled-j08-late-final": { surface: "desktop", cellMode: "j08-late-final" },
  "electron-controlled-j10-pending-lane": { surface: "desktop", cellMode: "j10-pending-lane" },
  "electron-controlled-j10-tool-result": { surface: "desktop", cellMode: "j10-tool-result" },
  "electron-controlled-j10-provider-accepted": { surface: "desktop", cellMode: "j10-provider-accepted" },
  "electron-controlled-j10-human-interrupting": { surface: "desktop", cellMode: "j10-human-interrupting" },
  "electron-controlled-j10-final-before-inbox": { surface: "desktop", cellMode: "j10-final-before-inbox" },
} as const satisfies Readonly<Record<string, Readonly<{
  surface: "browser" | "desktop";
  cellMode: Exclude<ControlledJourneyCellMode, "main">;
}>>>);

const ALLOWED_CELLS = new Set(CELL_NAMES.map((name) => `cell_${name}`));
const UI_ENVIRONMENT_KEYS = Object.freeze([
  "AGENT_WORKSPACE_JOURNEY_BROWSER_URL",
  "AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN",
  "AGENT_WORKSPACE_JOURNEY_HOST_LEDGER",
  "AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN",
  "AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER",
  "AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE",
  "AGENT_WORKSPACE_JOURNEY_PROVIDER_BARRIER_RUNNER",
  "AGENT_WORKSPACE_JOURNEY_CELL_MODE",
  "AGENT_WORKSPACE_OWNER_ID",
  "AGENT_WORKSPACE_ACP_TASK_PROVIDER_FAMILY",
  "AGENT_WORKSPACE_ACP_TASK_MODEL",
  "AGENT_WORKSPACE_ACP_META_PROFILE_OPTION_ID",
  "AGENT_WORKSPACE_RELEASE_SCENARIO_ID",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const);
const ELECTRON_UI_ENVIRONMENT_KEYS = Object.freeze([
  "AGENT_WORKSPACE_RUNTIME_URL",
  "AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN",
  "AGENT_WORKSPACE_RUNTIME_ORIGIN",
] as const);

export class ReleaseCellWorkerBlockedError extends Error {}

export type ReleaseCellWorkerInput = Readonly<{
  matrixFile: string;
  cellId: string;
  scenarioId: string;
  outputDirectory: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

/**
 * Audited unsigned-cell worker. The parent runner validates and signs its
 * candidate streams; this process never receives an issuer capability.
 */
export async function runReleaseCellWorker(input: ReleaseCellWorkerInput): Promise<void> {
  input.signal?.throwIfAborted();
  const environment = input.environment ?? process.env;
  const matrixFile = await requirePrivateAbsoluteFile(input.matrixFile, "journey_release_worker_matrix_path_invalid");
  const outputDirectory = await requireEmptyPrivateOutput(input.outputDirectory, input.cellId);
  const matrix = JSON.parse(await readFile(matrixFile, "utf8")) as JourneyReleaseMatrix;
  validateFrozenMatrix(matrix);
  const cell = requiredCell(matrix, input.cellId, input.scenarioId);
  validateEnvironmentIdentity(environment, matrix, cell);
  const cellName = cell.bundleCellId.slice("cell_".length) as ReleaseCellName;
  await assertReleaseNonBuildDigests(matrix, environment);
  try {
    if (cellName in BRIDGE_MODES) {
      await assertProductionArtifactDigest(matrix.digests.buildDigest);
      try {
        await runBridgeCell(matrix, cell, outputDirectory, BRIDGE_MODES[cellName]!);
      } finally {
        await assertProductionArtifactDigest(matrix.digests.buildDigest);
      }
      return;
    }
    if (cellName in UI_MAIN_MODES) {
      await runControlledUiCell(
        matrix,
        cell,
        outputDirectory,
        UI_MAIN_MODES[cellName as keyof typeof UI_MAIN_MODES],
        environment,
        "main",
        input.signal,
      );
      return;
    }
    if (cellName in UI_BRANCH_MODES) {
      const branch = UI_BRANCH_MODES[cellName as keyof typeof UI_BRANCH_MODES];
      await runControlledUiCell(matrix, cell, outputDirectory, branch.surface, environment, branch.cellMode, input.signal);
      return;
    }
    if (cellName === "opencode-acp-task"
      || cellName === "codex-acp-task"
      || cellName === "acp-meta") {
      await runAcpReleaseCell(matrix, cell, outputDirectory, environment, input.signal);
      return;
    }
    throw new ReleaseCellWorkerBlockedError(`${cellName} launch mode is not configured`);
  } finally {
    await assertReleaseNonBuildDigests(matrix, environment);
  }
}

/**
 * Produces a child environment by issuer. UI drivers receive only locator
 * inputs and read-only evidence access. ACP attestor launchers remain blocked
 * until their lane-specific preflight can construct a narrower environment.
 */
export function childEnvironmentForIssuer(
  issuer: ReleaseIssuer,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const) copy(key);
  if (issuer === "browser_ui_driver" || issuer === "electron_ui_driver") {
    for (const key of UI_ENVIRONMENT_KEYS) copy(key);
    if (issuer === "electron_ui_driver") {
      for (const key of ELECTRON_UI_ENVIRONMENT_KEYS) copy(key);
    }
  } else if (issuer === "opencode_acp_task_attestor"
    || issuer === "codex_acp_task_attestor"
    || issuer === "acp_meta_attestor") {
    // The Phase 8 launcher supplies only a parsed, lane-specific ACP envelope.
    // Until that envelope exists no ambient Provider input crosses this boundary.
  }
  return result;

  function copy(key: string): void {
    if (source[key] !== undefined) result[key] = source[key];
  }
}

async function runAcpReleaseCell(
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
  outputDirectory: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const cellId = cell.bundleCellId as AcpReleaseCellId;
  const descriptor = ACP_RELEASE_CELL_LAUNCHERS[cellId];
  const environmentKey = ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS[cellId];
  if (!descriptor || !environmentKey) throw new Error("journey_release_acp_cell_registry_invalid");
  const hostEnvironmentFile = environment[environmentKey];
  if (!hostEnvironmentFile) {
    const code = cellId === "cell_opencode-acp-task"
      ? "acp_release_opencode_task_host_environment_missing"
      : cellId === "cell_codex-acp-task"
        ? "acp_release_codex_task_host_environment_missing"
        : "acp_release_meta_host_environment_missing";
    throw new ReleaseCellWorkerBlockedError(code);
  }
  await requirePrivateAbsoluteFile(hostEnvironmentFile, "journey_release_acp_host_environment_invalid");
  await assertProductionArtifactDigest(matrix.digests.buildDigest);
  const stateRoot = await createCanonicalPrivateTempRoot(`agent-workspace-${cell.bundleCellId}-`);
  const manifestPath = path.join(stateRoot, "launch.json");
  let launcher: Readonly<{ close(): Promise<void> }> | undefined;
  let launcherClosed = false;
  try {
    launcher = await startAcpLauncher({
      matrix,
      cell,
      stateRoot,
      manifestPath,
      hostEnvironmentFile,
      environment,
      signal,
    });
    const manifest = await readAcpManifest(
      manifestPath,
      stateRoot,
      cell,
      descriptor.issuer,
      matrix.digests.buildDigest,
    );
    const driver = await acpDriverSource(manifest, descriptor.kind);
    const driverEnvironment = childEnvironmentForIssuer(
      descriptor.kind === "task" ? "electron_ui_driver" : "browser_ui_driver",
      driver.environment,
    );
    const suiteResult = await spawnBounded(process.execPath, [
      JOURNEY_SUITE_RUNNER,
      descriptor.kind === "task" ? "acp-task" : "acp-meta",
    ], {
      cwd: REPOSITORY_ROOT,
      environment: driverEnvironment,
      timeoutMs: 1_200_000,
      signal,
    });
    if (suiteResult.exitCode === 2) {
      throw new ReleaseCellWorkerBlockedError("acp_release_actual_operation_blocked");
    }
    if (suiteResult.exitCode !== 0) {
      throw new Error(`journey_release_acp_actual_operation_failed:${suiteResult.exitCode}:${suiteResult.diagnostic}`);
    }

    const actionDocument = await readActionDocument(manifest.actionEvidenceFile);
    const hostCommands = validateHostCommands(
      await fetchLoopbackJson(
        manifest.hostLedgerUrl,
        "journey_release_acp_host_ledger_unavailable",
        driver.evidenceToken,
        { signal },
      ),
      cell,
    );
    const hostOperations = validateAcpHostOperations(
      await fetchLoopbackJson(
        manifest.operationLedgerUrl,
        "journey_release_acp_operation_ledger_unavailable",
        driver.evidenceToken,
        { signal },
      ),
      cell,
    );
    const health = validateAcpHealth(
      await fetchLoopbackJson(manifest.healthUrl, "journey_release_acp_health_unavailable", undefined, { signal }),
      cell,
      descriptor.issuer,
    );
    const observedLineage = validateObservedLineage(
      await fetchLoopbackJson(
        manifest.observedLineageUrl,
        "journey_release_acp_observed_lineage_unavailable",
        driver.evidenceToken,
        { signal },
      ),
      cell,
    );
    validateReferencedLineageIds(hostCommands, observedLineage);
    await assertUnavailableAttestationLane(manifest.unavailableAttestationLedgerUrl, driver.evidenceToken, signal);
    const releaseIdentity: NativeReleaseIdentity = Object.freeze({
      releaseRunId: matrix.releaseRunId,
      nonce: matrix.nonce,
      bundleCellId: cell.bundleCellId,
      scenarioId: cell.scenarioId,
      runtimeInstanceId: cell.lineage.runtimeInstanceId,
      issuer: descriptor.issuer,
    });
    await finalizeCleanupFencedReleaseEvidence({
      stateRoot,
      async closeLauncher() {
        await launcher?.close();
        launcherClosed = true;
      },
      async readFinalEvidence() {
        const expectedHostGenerations = ACP_EXPECTED_HOST_GENERATIONS[descriptor.issuer];
        const persisted = await readFinalizedNativeUnifiedHostAttestation({
          stateRoot,
          releaseIdentity,
          expectedHostGenerations,
          expectedObservedLineageDigest: observedLineage.canonicalDigest,
        });
        return validateAcpReleaseAttestationDocument(persisted, {
          ...releaseIdentity,
          observedLineageDigest: observedLineage.canonicalDigest,
          expectedHostGenerations,
        });
      },
      async writeLedgers(attestation) {
        await assertProductionArtifactDigest(matrix.digests.buildDigest);
        return emitAcpReleaseEvidence({
          matrix,
          cell,
          outputDirectory,
          stateRoot,
          descriptor,
          actionDocument,
          hostCommands,
          hostOperations,
          health,
          observedLineage,
          attestation,
        });
      },
      async emitCandidate(streams) {
        await writeCandidate(outputDirectory, matrix, cell, streams, observedLineage);
      },
    });
  } catch (error) {
    if (launcher && !launcherClosed) {
      try {
        await launcher.close();
      } catch (cleanupError) {
        throw cleanupError;
      }
    }
    throw error;
  }
}

async function startAcpLauncher(input: Readonly<{
  matrix: JourneyReleaseMatrix;
  cell: JourneyReleaseCellDeclaration;
  stateRoot: string;
  manifestPath: string;
  hostEnvironmentFile: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>): Promise<Readonly<{ close(): Promise<void> }>> {
  await requireRegularFile(ACP_RELEASE_LAUNCHER, "journey_release_acp_launcher_invalid");
  const identityFile = path.join(input.stateRoot, "cell-identity.json");
  const descriptor = ACP_RELEASE_CELL_LAUNCHERS[input.cell.bundleCellId as AcpReleaseCellId];
  await writePrivateJson(identityFile, {
    releaseRunId: input.matrix.releaseRunId,
    nonce: input.matrix.nonce,
    bundleCellId: input.cell.bundleCellId,
    scenarioId: input.cell.scenarioId,
    runtimeInstanceId: input.cell.lineage.runtimeInstanceId,
    issuer: descriptor.issuer,
  });
  const child = spawnOwnedProcess(process.execPath, [
    path.join(REPOSITORY_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    ACP_RELEASE_LAUNCHER,
    "--manifest", input.manifestPath,
    "--state-root", input.stateRoot,
    "--identity", identityFile,
    "--host-environment", input.hostEnvironmentFile,
    "--build-digest", input.matrix.digests.buildDigest,
  ], {
    cwd: REPOSITORY_ROOT,
    env: childEnvironmentForIssuer("runtime_host", input.environment),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  await waitForAcpLauncherReady(
    child,
    input.manifestPath,
    input.cell.lineage.runtimeInstanceId,
    descriptor.issuer,
    input.signal,
  );
  return Object.freeze({ close: () => stopChild(child) });
}

function waitForAcpLauncherReady(
  child: ChildProcess,
  manifestPath: string,
  runtimeInstanceId: string,
  issuer: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!child.stdout || !child.stderr) return Promise.reject(new Error("journey_release_acp_launcher_stdio_missing"));
  const stdout = child.stdout;
  const stderr = child.stderr;
  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("journey_release_acp_launcher_timeout")), 900_000);
    const onAbort = () => finish(new Error("journey_release_worker_terminated"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const count = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 2 * 1024 * 1024) finish(new Error("journey_release_acp_launcher_output_limit"));
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
        if (isRecord(value)
          && Object.keys(value).sort().join(",") === "browserUrl,healthUrl,issuer,manifestPath,runtimeInstanceId,type"
          && value.type === "acp_release_cell_ready"
          && value.manifestPath === manifestPath
          && value.runtimeInstanceId === runtimeInstanceId
          && value.issuer === issuer
          && typeof value.browserUrl === "string"
          && typeof value.healthUrl === "string") {
          finish();
          return;
        }
      }
    }
    function onError(): void { finish(new Error("journey_release_acp_launcher_spawn_failed")); }
    function onExit(code: number | null): void {
      finish(code === 2
        ? new ReleaseCellWorkerBlockedError("acp_release_launcher_blocked")
        : new Error("journey_release_acp_launcher_exited"));
    }
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      stdout.off("data", onStdout);
      stderr.off("data", count);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) void stopChild(child).then(() => reject(error), reject);
      else resolve();
    }
  });
}

async function readAcpManifest(
  manifestPath: string,
  stateRoot: string,
  cell: JourneyReleaseCellDeclaration,
  issuer: string,
  expectedBuildDigest: string,
): Promise<AcpReleaseCellManifest> {
  await requirePrivateAbsoluteFile(manifestPath, "journey_release_acp_manifest_invalid");
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const keys = [
    "schemaVersion", "kind", "issuer", "browserUrl", "hostLedgerUrl", "operationLedgerUrl",
    "observedLineageUrl", "healthUrl", "attestationLedgerUrl", "unavailableAttestationLedgerUrl",
    "runtimeInstanceId", "lineageId", "restartExecutable", "actionEvidenceFile",
    "electronEnvironmentFile", "runnerEnvironmentFile", "electronMain", "workbenchBuild", "buildDigest",
  ];
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || value.schemaVersion !== 1
    || value.kind !== "acp_release_cell"
    || value.issuer !== issuer
    || value.runtimeInstanceId !== cell.lineage.runtimeInstanceId
    || value.lineageId !== `session_id_native_lineage_${cell.lineage.runtimeInstanceId}`
    || value.buildDigest !== expectedBuildDigest) {
    throw new Error("journey_release_acp_manifest_invalid");
  }
  for (const field of [
    "browserUrl", "hostLedgerUrl", "operationLedgerUrl", "observedLineageUrl", "healthUrl",
    "attestationLedgerUrl", "unavailableAttestationLedgerUrl",
  ] as const) {
    requireLoopbackUrl(value[field], `journey_release_acp_${field}_invalid`);
  }
  const selectedPath = new URL(value.attestationLedgerUrl as string).pathname;
  const unavailablePath = new URL(value.unavailableAttestationLedgerUrl as string).pathname;
  if ((issuer === "acp_meta_attestor"
    ? selectedPath !== "/evidence/acp-meta" || unavailablePath !== "/evidence/acp-provider"
    : selectedPath !== "/evidence/acp-provider" || unavailablePath !== "/evidence/acp-meta")) {
    throw new Error("journey_release_acp_manifest_lane_invalid");
  }
  for (const field of [
    "restartExecutable", "actionEvidenceFile", "electronEnvironmentFile", "runnerEnvironmentFile",
  ] as const) {
    if (typeof value[field] !== "string" || !path.isAbsolute(value[field]) || !isWithin(stateRoot, value[field] as string)) {
      throw new Error("journey_release_acp_manifest_path_scope_invalid");
    }
  }
  if (value.electronMain !== EXPECTED_ELECTRON_MAIN || value.workbenchBuild !== EXPECTED_WORKBENCH_BUILD) {
    throw new Error("journey_release_acp_manifest_artifact_invalid");
  }
  const manifest = value as unknown as AcpReleaseCellManifest;
  await requireExecutable(manifest.restartExecutable, "journey_release_acp_restart_executable_invalid");
  await requirePrivateAbsoluteFile(manifest.actionEvidenceFile, "journey_release_acp_action_evidence_invalid");
  await requirePrivateAbsoluteFile(manifest.electronEnvironmentFile, "journey_release_acp_electron_environment_invalid");
  await requirePrivateAbsoluteFile(manifest.runnerEnvironmentFile, "journey_release_acp_runner_environment_invalid");
  await requireRegularFile(manifest.electronMain, "journey_release_acp_electron_main_invalid");
  await requireRegularFile(manifest.workbenchBuild, "journey_release_acp_workbench_build_invalid");
  return manifest;
}

async function acpDriverSource(
  manifest: AcpReleaseCellManifest,
  kind: "task" | "meta",
): Promise<Readonly<{ environment: NodeJS.ProcessEnv; evidenceToken: string }>> {
  const value = JSON.parse(await readFile(manifest.runnerEnvironmentFile, "utf8")) as unknown;
  const taskKeys = [
    "AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN", "AGENT_WORKSPACE_ACP_TASK_PROVIDER_FAMILY",
    "AGENT_WORKSPACE_ACP_TASK_MODEL", "AGENT_WORKSPACE_RELEASE_SCENARIO_ID",
  ];
  const metaKeys = [
    "AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN", "AGENT_WORKSPACE_ACP_META_PROFILE_OPTION_ID",
    "AGENT_WORKSPACE_RELEASE_SCENARIO_ID",
  ];
  const keys = kind === "task" ? taskKeys : metaKeys;
  if (!isRecord(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || keys.some((key) => typeof value[key] !== "string" || !(value[key] as string).trim())) {
    throw new Error("journey_release_acp_runner_environment_invalid");
  }
  const evidenceToken = value.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN as string;
  if (evidenceToken.length < 32 || /\s/u.test(evidenceToken)) {
    throw new Error("journey_release_acp_runner_environment_invalid");
  }
  const source: NodeJS.ProcessEnv = {
    AGENT_WORKSPACE_JOURNEY_BROWSER_URL: manifest.browserUrl,
    AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN: manifest.electronMain,
    AGENT_WORKSPACE_JOURNEY_HOST_LEDGER: manifest.hostLedgerUrl,
    AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER: manifest.restartExecutable,
    AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE: manifest.actionEvidenceFile,
    AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: evidenceToken,
    AGENT_WORKSPACE_OWNER_ID: "user_local",
    AGENT_WORKSPACE_RELEASE_SCENARIO_ID: value.AGENT_WORKSPACE_RELEASE_SCENARIO_ID as string,
    PLAYWRIGHT_BROWSERS_PATH: await resolvePlaywrightBrowsersPath(),
    ...(kind === "task"
      ? {
          AGENT_WORKSPACE_ACP_TASK_PROVIDER_FAMILY: value.AGENT_WORKSPACE_ACP_TASK_PROVIDER_FAMILY as string,
          AGENT_WORKSPACE_ACP_TASK_MODEL: value.AGENT_WORKSPACE_ACP_TASK_MODEL as string,
        }
      : { AGENT_WORKSPACE_ACP_META_PROFILE_OPTION_ID: value.AGENT_WORKSPACE_ACP_META_PROFILE_OPTION_ID as string }),
  };
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const) {
    if (process.env[key] !== undefined) source[key] = process.env[key];
  }
  if (kind === "task") Object.assign(source, await readElectronEnvironment(manifest.electronEnvironmentFile, manifest));
  return Object.freeze({ environment: source, evidenceToken });
}

function validateAcpHealth(
  value: unknown,
  cell: JourneyReleaseCellDeclaration,
  issuer: string,
): Readonly<Record<string, unknown>> {
  const keys = ["schemaVersion", "status", "runtimeInstanceId", "generation", "issuer"];
  if (!isRecord(value) || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || value.schemaVersion !== 1 || value.status !== "ready"
    || value.runtimeInstanceId !== cell.lineage.runtimeInstanceId
    || value.issuer !== issuer
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new Error("journey_release_acp_health_invalid");
  }
  return Object.freeze({ ...value });
}

function validateAcpHostOperations(
  value: unknown,
  cell: JourneyReleaseCellDeclaration,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("journey_release_acp_operation_ledger_invalid");
  let sequence = 0;
  for (const entry of value) {
    const keys = ["sequence", "kind", "runtimeInstanceId", "generation", "observedAt"];
    if (!isRecord(entry) || Object.keys(entry).length !== keys.length
      || Object.keys(entry).some((key) => !keys.includes(key))
      || entry.sequence !== ++sequence
      || !["host_started", "restart_accepted", "shutdown_accepted", "release_observations_claimed"].includes(entry.kind as string)
      || entry.runtimeInstanceId !== cell.lineage.runtimeInstanceId
      || !Number.isSafeInteger(entry.generation) || (entry.generation as number) < 1
      || typeof entry.observedAt !== "string") {
      throw new Error("journey_release_acp_operation_ledger_invalid");
    }
  }
  return Object.freeze(value.map((entry) => Object.freeze({ ...(entry as Readonly<Record<string, unknown>>) })));
}

async function assertUnavailableAttestationLane(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  requireLoopbackUrl(url, "journey_release_acp_unavailable_lane_url_invalid");
  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${token}` },
    signal,
  }).catch(() => undefined);
  if (!response || response.status !== 404) throw new Error("journey_release_acp_unavailable_lane_not_closed");
}

async function emitAcpReleaseEvidence(input: Readonly<{
  matrix: JourneyReleaseMatrix;
  cell: JourneyReleaseCellDeclaration;
  outputDirectory: string;
  stateRoot: string;
  descriptor: typeof ACP_RELEASE_CELL_LAUNCHERS[AcpReleaseCellId];
  actionDocument: Readonly<Record<string, unknown>>;
  hostCommands: readonly HostCommandLedgerEntry[];
  hostOperations: readonly Readonly<Record<string, unknown>>[];
  health: Readonly<Record<string, unknown>>;
  observedLineage: ObservedLineage;
  attestation: ReturnType<typeof validateAcpReleaseAttestationDocument>;
}>): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const fullBundles = input.descriptor.kind === "task"
    ? actionBundles(input.actionDocument, "cross", input.cell)
    : actionBundles(input.actionDocument, "browser", input.cell);
  const correlatedCommandIds = new Set(fullBundles.flatMap(({ correlations }) =>
    correlations.map(({ commandId }) => commandId)));
  if (correlatedCommandIds.size !== input.hostCommands.length
    || input.hostCommands.some(({ commandId }) => !correlatedCommandIds.has(commandId))) {
    throw new Error("journey_release_acp_ui_host_command_coverage_invalid");
  }
  const isolationAlias = `alias_cell_root_${createHash("sha256").update(input.stateRoot).digest("hex").slice(0, 20)}`;
  const streams: Readonly<Record<string, unknown>>[] = [];
  for (const bundle of fullBundles) {
      const requirement = exactRequirement(input.cell, bundle.issuer);
      const checkpoints = new Set(requirement.checkpoints);
      const traces = bundle.traces.filter(({ checkpoint }) => checkpoints.has(checkpoint));
      const traceIds = new Set(traces.map(({ actionTraceId }) => actionTraceId));
      const correlations = bundle.correlations.filter(({ actionTraceId }) => traceIds.has(actionTraceId));
      const projected = Object.freeze({ ...bundle, traces: Object.freeze(traces), correlations: Object.freeze(correlations) });
      validateUiActionBundle(projected, input.cell, requirement);
      const ledgerFile = bundle.issuer === "browser_ui_driver" ? "browser-ui.json" : "electron-ui.json";
      await writePrivateJson(path.join(input.outputDirectory, ledgerFile), {
        schemaVersion: 1,
        releaseRunId: input.matrix.releaseRunId,
        nonce: input.matrix.nonce,
        bundleCellId: input.cell.bundleCellId,
        scenarioId: input.cell.scenarioId,
        runtimeInstanceId: input.cell.lineage.runtimeInstanceId,
        observedLineageDigest: input.observedLineage.canonicalDigest,
        isolationAlias,
        checkpointFacts: traces.map((trace) => ({
          checkpoint: trace.checkpoint,
          event: "visible_locator_action_completed",
          actionTraceId: trace.actionTraceId,
          intentKind: trace.intentKind,
          action: trace.action,
          target: trace.target,
          correlatedCommandIds: correlations
            .filter(({ actionTraceId }) => actionTraceId === trace.actionTraceId)
            .map(({ commandId }) => commandId),
        })),
      });
      streams.push(Object.freeze({
        issuer: bundle.issuer,
        journeyId: `journey_${input.cell.bundleCellId.slice("cell_".length)}`,
        outcome: "PASS",
        checkpoints: requirement.checkpoints,
        ledgerFile,
        observedLineageDigest: input.observedLineage.canonicalDigest,
        actionTraces: traces,
        actionCorrelations: correlations,
      }));
  }

  const runtimeRequirement = exactRequirement(input.cell, "runtime_host");
  const allTraces = fullBundles.flatMap(({ traces }) => traces);
  const allCorrelations = fullBundles.flatMap(({ correlations }) => correlations);
  await writePrivateJson(path.join(input.outputDirectory, "runtime-host.json"), {
    schemaVersion: 1,
    releaseRunId: input.matrix.releaseRunId,
    nonce: input.matrix.nonce,
    bundleCellId: input.cell.bundleCellId,
    scenarioId: input.cell.scenarioId,
    runtimeInstanceId: input.cell.lineage.runtimeInstanceId,
    observedLineage: input.observedLineage,
    observedLineageDigest: input.observedLineage.canonicalDigest,
    isolationAlias,
    health: input.health,
    hostCommands: input.hostCommands,
    hostOperations: input.hostOperations,
    checkpointFacts: runtimeRequirement.checkpoints.map((checkpoint) => ({
      checkpoint,
      event: "native_acp_host_checkpoint_correlated",
      generation: input.health.generation,
      actionTraceIds: allTraces.filter((trace) => trace.checkpoint === checkpoint).map(({ actionTraceId }) => actionTraceId),
      commandIds: allCorrelations.filter((entry) => entry.checkpoint === checkpoint).map(({ commandId }) => commandId),
    })),
  });
  streams.push(Object.freeze({
    issuer: "runtime_host",
    journeyId: `journey_${input.cell.bundleCellId.slice("cell_".length)}`,
    outcome: "PASS",
    checkpoints: runtimeRequirement.checkpoints,
    ledgerFile: "runtime-host.json",
    observedLineageDigest: input.observedLineage.canonicalDigest,
  }));

  const attestationLedgerFile = input.descriptor.kind === "meta" ? "acp-meta.json" : "acp-provider.json";
  await writePrivateJson(path.join(input.outputDirectory, attestationLedgerFile), input.attestation);
  const attestorRequirement = exactRequirement(input.cell, input.descriptor.issuer);
  streams.push(Object.freeze({
    issuer: input.descriptor.issuer,
    journeyId: `journey_${input.cell.bundleCellId.slice("cell_".length)}`,
    outcome: "PASS",
    checkpoints: attestorRequirement.checkpoints,
    ledgerFile: attestationLedgerFile,
    observedLineageDigest: input.observedLineage.canonicalDigest,
  }));
  return Object.freeze(streams);
}

async function runControlledUiCell(
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
  outputDirectory: string,
  mode: "browser" | "desktop" | "cross",
  environment: NodeJS.ProcessEnv,
  cellMode: ControlledJourneyCellMode,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await assertProductionArtifactDigest(matrix.digests.buildDigest);
  const stateRoot = await createCanonicalPrivateTempRoot(`agent-workspace-${cell.bundleCellId}-`);
  const manifestPath = path.join(stateRoot, "launch.json");
  const driverHome = path.join(stateRoot, "ui-driver-home");
  await mkdir(driverHome, { mode: 0o700 });
  await chmod(driverHome, 0o700);
  let launcher: Awaited<ReturnType<typeof startControlledLauncher>> | undefined;
  let launcherClosed = false;
  try {
    launcher = await startControlledLauncher({
      stateRoot,
      manifestPath,
      lineage: cell.lineage,
      environment,
      cellMode,
      signal,
    });
    const manifest = await readControlledManifest(manifestPath, stateRoot, cell, cellMode, matrix.digests.buildDigest);
    const driver = await controlledDriverSource(manifest, mode);
    const driverEnvironment = childEnvironmentForIssuer(
      mode === "browser" ? "browser_ui_driver" : "electron_ui_driver",
      driver.environment,
    );
    driverEnvironment.HOME = driverHome;
    const suiteResult = await spawnBounded(process.execPath, [JOURNEY_SUITE_RUNNER, mode], {
      cwd: REPOSITORY_ROOT,
      environment: driverEnvironment,
      timeoutMs: mode === "cross" ? 300_000 : 240_000,
      signal,
    });
    if (suiteResult.exitCode === 2) {
      throw new ReleaseCellWorkerBlockedError(`${mode} actual-operation suite reported blocked capability`);
    }
    if (suiteResult.exitCode !== 0) {
      throw new Error(`journey_release_${mode}_suite_failed:${suiteResult.exitCode}:${suiteResult.diagnostic}`);
    }

    const actionDocument = await readActionDocument(manifest.actionEvidenceFile);
    const hostCommands = validateHostCommands(
      await fetchLoopbackJson(manifest.hostLedgerUrl, "journey_release_host_ledger_unavailable", driver.evidenceToken, { signal }),
      cell,
    );
    const hostOperations = validateHostOperations(
      await fetchLoopbackJson(manifest.operationLedgerUrl, "journey_release_operation_ledger_unavailable", driver.evidenceToken, { signal }),
      cell,
      manifest.lineageId,
      cellMode,
    );
    const health = validateControlledHealth(
      await fetchLoopbackJson(manifest.healthUrl, "journey_release_host_health_unavailable", undefined, { signal }),
      cell,
      cellMode,
    );
    const observedLineage = validateObservedLineage(
      await fetchLoopbackJson(
        manifest.observedLineageUrl,
        "journey_release_observed_lineage_unavailable",
        driver.evidenceToken,
        { signal },
      ),
      cell,
    );
    validateReferencedLineageIds(hostOperations, observedLineage);
    validateControlledBranchOperations(hostOperations, health, cellMode);
    await finalizeCleanupFencedReleaseEvidence({
      stateRoot,
      async closeLauncher() {
        await launcher?.close();
        launcherClosed = true;
      },
      async readFinalEvidence() {
        return undefined;
      },
      async writeLedgers() {
        await assertProductionArtifactDigest(matrix.digests.buildDigest);
        return emitControlledUiEvidence({
          matrix,
          cell,
          outputDirectory,
          mode,
          stateRoot,
          actionDocument,
          hostCommands,
          hostOperations,
          health,
          observedLineage,
        });
      },
      async emitCandidate(streams) {
        await writeCandidate(outputDirectory, matrix, cell, streams, observedLineage);
      },
    });
  } catch (error) {
    if (launcher && !launcherClosed) {
      try {
        await launcher.close();
      } catch (cleanupError) {
        throw cleanupError;
      }
    }
    throw error;
  }
}

type ControlledManifest = Readonly<{
  schemaVersion: 1;
  evidenceClass: "deterministic_fake";
  cellMode: ControlledJourneyCellMode;
  browserUrl: string;
  hostLedgerUrl: string;
  operationLedgerUrl: string;
  observedLineageUrl: string;
  healthUrl: string;
  runtimeInstanceId: string;
  lineageId: string;
  lineage: JourneyEvidenceLineage;
  restartExecutable: string;
  providerBarrierExecutable: string;
  actionEvidenceFile: string;
  electronEnvironmentFile: string;
  runnerEnvironmentFile: string;
  electronMain: string;
  workbenchBuild: string;
  buildDigest: string;
}>;

type ObservedLineage = Readonly<{
  schemaVersion: 1;
  runtimeInstanceId: string;
  templateDraftIds: readonly string[];
  taskSetupDraftIds: readonly string[];
  taskIds: readonly string[];
  runIds: readonly string[];
  metaSessionIds: readonly string[];
  metaTurnIds: readonly string[];
  cardSessionSlotIds: readonly string[];
  logicalSessionIds: readonly string[];
  bindingIds: readonly string[];
  messageIds: readonly string[];
  messageForwardIds: readonly string[];
  humanInterventionIds: readonly string[];
  inputSubmissionIds: readonly string[];
  sessionTurnIds: readonly string[];
  sessionControlAuditIds: readonly string[];
  canonicalDigest: string;
}>;

type UiActionBundle = Readonly<{
  issuer: "browser_ui_driver" | "electron_ui_driver";
  traces: readonly JourneyActionTrace[];
  correlations: readonly ActionCommandCorrelation[];
}>;

async function startControlledLauncher(input: Readonly<{
  stateRoot: string;
  manifestPath: string;
  lineage: JourneyEvidenceLineage;
  environment: NodeJS.ProcessEnv;
  cellMode: ControlledJourneyCellMode;
  signal?: AbortSignal;
}>): Promise<Readonly<{ close(): Promise<void> }>> {
  await requireRegularFile(CONTROLLED_LAUNCHER, "journey_release_controlled_launcher_invalid");
  const lineageFile = path.join(input.stateRoot, "release-cell-lineage.json");
  await writePrivateJson(lineageFile, input.lineage);
  const child = spawnOwnedProcess(process.execPath, [
    CONTROLLED_LAUNCHER,
    "--manifest", input.manifestPath,
    "--state-root", input.stateRoot,
    "--lineage", lineageFile,
    "--cell-mode", input.cellMode,
    "--skip-build",
  ], {
    cwd: REPOSITORY_ROOT,
    env: childEnvironmentForIssuer("runtime_host", input.environment),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  await waitForControlledReady(child, input.manifestPath, input.lineage.runtimeInstanceId, input.signal);
  return Object.freeze({ close: () => stopChild(child) });
}

function waitForControlledReady(
  child: ChildProcess,
  manifestPath: string,
  runtimeInstanceId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!child.stdout || !child.stderr) return Promise.reject(new Error("journey_release_controlled_launcher_stdio_missing"));
  const stdout = child.stdout;
  const stderr = child.stderr;
  return new Promise<void>((resolve, reject) => {
    let stdoutBuffer = "";
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("journey_release_controlled_launcher_timeout")), 180_000);
    const onAbort = () => finish(new Error("journey_release_worker_terminated"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const count = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 2 * 1024 * 1024) finish(new Error("journey_release_controlled_launcher_output_limit"));
    };
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      count(chunk);
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { value = undefined; }
        if (isControlledReady(value, manifestPath, runtimeInstanceId)) finish();
      }
    });
    stderr.on("data", count);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(new Error(
      `journey_release_controlled_launcher_exited:${code ?? signal ?? "unknown"}`,
    )));

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        void stopChild(child).then(() => reject(error), reject);
      } else {
        resolve();
      }
    }
  });
}

function isControlledReady(value: unknown, manifestPath: string, runtimeInstanceId: string): boolean {
  if (!isRecord(value)) return false;
  const allowed = ["type", "manifestPath", "browserUrl", "healthUrl", "runtimeInstanceId"];
  return Object.keys(value).every((key) => allowed.includes(key))
    && value.type === "controlled_journey_ready"
    && value.manifestPath === manifestPath
    && value.runtimeInstanceId === runtimeInstanceId
    && typeof value.browserUrl === "string"
    && typeof value.healthUrl === "string";
}

async function readControlledManifest(
  manifestPath: string,
  stateRoot: string,
  cell: JourneyReleaseCellDeclaration,
  expectedCellMode: ControlledJourneyCellMode,
  expectedBuildDigest: string,
): Promise<ControlledManifest> {
  await requirePrivateAbsoluteFile(manifestPath, "journey_release_controlled_manifest_invalid");
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const allowed = [
    "schemaVersion", "evidenceClass", "cellMode", "browserUrl", "hostLedgerUrl", "operationLedgerUrl", "observedLineageUrl", "healthUrl",
    "runtimeInstanceId", "lineageId", "lineage", "restartExecutable", "providerBarrierExecutable",
    "actionEvidenceFile", "electronEnvironmentFile", "runnerEnvironmentFile", "electronMain", "workbenchBuild", "buildDigest",
  ];
  if (!isRecord(value)
    || Object.keys(value).some((key) => !allowed.includes(key))
    || value.schemaVersion !== 1
    || value.evidenceClass !== "deterministic_fake"
    || value.cellMode !== expectedCellMode
    || value.buildDigest !== expectedBuildDigest
    || value.runtimeInstanceId !== cell.lineage.runtimeInstanceId
    || value.lineageId !== `session_id_controlled_lineage_${cell.lineage.runtimeInstanceId}`) {
    throw new ReleaseCellWorkerBlockedError("controlled launcher did not preserve the frozen Runtime anchor");
  }
  if (!("lineage" in value)) {
    throw new ReleaseCellWorkerBlockedError("controlled launcher does not project the frozen Runtime anchor");
  }
  if (!isDeepStrictEqual(value.lineage, cell.lineage)) {
    throw new ReleaseCellWorkerBlockedError("controlled launcher Runtime anchor differs from the frozen cell");
  }
  for (const field of ["browserUrl", "hostLedgerUrl", "operationLedgerUrl", "observedLineageUrl", "healthUrl"] as const) {
    requireLoopbackUrl(value[field], `journey_release_controlled_${field}_invalid`);
  }
  for (const field of [
    "restartExecutable", "providerBarrierExecutable", "actionEvidenceFile", "electronEnvironmentFile", "runnerEnvironmentFile",
    "electronMain", "workbenchBuild",
  ] as const) {
    if (typeof value[field] !== "string" || !path.isAbsolute(value[field])) {
      throw new Error(`journey_release_controlled_${field}_invalid`);
    }
  }
  const manifest = value as unknown as ControlledManifest;
  if (!isWithin(stateRoot, manifest.restartExecutable)
    || !isWithin(stateRoot, manifest.providerBarrierExecutable)
    || !isWithin(stateRoot, manifest.actionEvidenceFile)
    || !isWithin(stateRoot, manifest.electronEnvironmentFile)
    || !isWithin(stateRoot, manifest.runnerEnvironmentFile)
    || manifest.electronMain !== EXPECTED_ELECTRON_MAIN
    || manifest.workbenchBuild !== EXPECTED_WORKBENCH_BUILD) {
    throw new Error("journey_release_controlled_manifest_path_scope_invalid");
  }
  await requireExecutable(manifest.restartExecutable, "journey_release_restart_executable_invalid");
  await requireExecutable(manifest.providerBarrierExecutable, "journey_release_provider_barrier_invalid");
  await requirePrivateAbsoluteFile(manifest.actionEvidenceFile, "journey_release_action_evidence_invalid");
  await requirePrivateAbsoluteFile(manifest.electronEnvironmentFile, "journey_release_electron_environment_invalid");
  await requirePrivateAbsoluteFile(manifest.runnerEnvironmentFile, "journey_release_runner_environment_invalid");
  await requireRegularFile(manifest.electronMain, "journey_release_electron_main_invalid");
  await requireRegularFile(manifest.workbenchBuild, "journey_release_workbench_build_invalid");
  return manifest;
}

async function assertProductionArtifactDigest(expected: string): Promise<void> {
  const observed = await productionArtifactDigest(REPOSITORY_ROOT);
  if (observed !== expected) throw new Error(`journey_release_production_artifact_drift:${observed}`);
}

async function assertReleaseNonBuildDigests(
  matrix: JourneyReleaseMatrix,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const runnerSha256 = requiredReleaseDigest(
    environment.AGENT_WORKSPACE_RELEASE_CELL_RUNNER_SHA256,
    "journey_release_runner_digest_missing",
  );
  const workerSha256 = requiredReleaseDigest(
    environment.AGENT_WORKSPACE_RELEASE_CELL_WORKER_SHA256,
    "journey_release_worker_digest_missing",
  );
  await assertProductionReleaseNonBuildDigests({
    repositoryRoot: REPOSITORY_ROOT,
    expected: matrix.digests,
    runnerSha256,
    workerSha256,
  });
}

function requiredReleaseDigest(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(code);
  return value;
}

async function controlledDriverSource(
  manifest: ControlledManifest,
  mode: "browser" | "desktop" | "cross",
): Promise<Readonly<{ environment: NodeJS.ProcessEnv; evidenceToken: string }>> {
  const evidenceToken = await readEvidenceEnvironment(manifest.runnerEnvironmentFile);
  const source: NodeJS.ProcessEnv = {
    AGENT_WORKSPACE_JOURNEY_BROWSER_URL: manifest.browserUrl,
    AGENT_WORKSPACE_JOURNEY_ELECTRON_MAIN: manifest.electronMain,
    AGENT_WORKSPACE_JOURNEY_HOST_LEDGER: manifest.hostLedgerUrl,
    AGENT_WORKSPACE_JOURNEY_HOST_RESTART_RUNNER: manifest.restartExecutable,
    AGENT_WORKSPACE_JOURNEY_PROVIDER_BARRIER_RUNNER: manifest.providerBarrierExecutable,
    AGENT_WORKSPACE_JOURNEY_ACTION_EVIDENCE_FILE: manifest.actionEvidenceFile,
    AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN: evidenceToken,
    AGENT_WORKSPACE_JOURNEY_CELL_MODE: manifest.cellMode,
    AGENT_WORKSPACE_OWNER_ID: "user_local",
    PLAYWRIGHT_BROWSERS_PATH: await resolvePlaywrightBrowsersPath(),
  };
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const) {
    if (process.env[key] !== undefined) source[key] = process.env[key];
  }
  if (mode === "desktop" || mode === "cross") {
    const electron = await readElectronEnvironment(manifest.electronEnvironmentFile, manifest);
    Object.assign(source, electron);
  }
  return Object.freeze({ environment: source, evidenceToken });
}

async function resolvePlaywrightBrowsersPath(): Promise<string> {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const value = configured ?? (platform() === "darwin"
    ? path.join(homedir(), "Library", "Caches", "ms-playwright")
    : platform() === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? homedir(), "ms-playwright")
      : path.join(homedir(), ".cache", "ms-playwright"));
  if (!path.isAbsolute(value)) throw new ReleaseCellWorkerBlockedError("Playwright browser registry path is not absolute");
  const status = await lstat(value).catch(() => undefined);
  if (!status?.isDirectory() || status.isSymbolicLink()) {
    throw new ReleaseCellWorkerBlockedError("Playwright browser registry is unavailable");
  }
  return path.resolve(value);
}

async function readEvidenceEnvironment(file: string): Promise<string> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || typeof value.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN !== "string"
    || value.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN.length < 32
    || /\s/u.test(value.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN)) {
    throw new Error("journey_release_runner_environment_invalid");
  }
  return value.AGENT_WORKSPACE_JOURNEY_EVIDENCE_TOKEN;
}

async function readElectronEnvironment(
  file: string,
  manifest: Readonly<{ browserUrl: string }>,
): Promise<NodeJS.ProcessEnv> {
  const value = JSON.parse(await readFile(file, "utf8")) as unknown;
  const allowed = [
    "AGENT_WORKSPACE_RUNTIME_URL", "AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN",
    "AGENT_WORKSPACE_RUNTIME_ORIGIN",
  ];
  if (!isRecord(value)
    || Object.keys(value).length !== allowed.length
    || Object.keys(value).some((key) => !allowed.includes(key))
    || allowed.some((key) => typeof value[key] !== "string" || !(value[key] as string).trim())
    || value.AGENT_WORKSPACE_RUNTIME_ORIGIN !== new URL(manifest.browserUrl).origin) {
    throw new Error("journey_release_electron_environment_invalid");
  }
  requireLoopbackUrl(value.AGENT_WORKSPACE_RUNTIME_URL, "journey_release_electron_runtime_url_invalid");
  return {
    AGENT_WORKSPACE_RUNTIME_URL: value.AGENT_WORKSPACE_RUNTIME_URL as string,
    AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN: value.AGENT_WORKSPACE_RUNTIME_DESKTOP_TOKEN as string,
    AGENT_WORKSPACE_RUNTIME_ORIGIN: value.AGENT_WORKSPACE_RUNTIME_ORIGIN as string,
  };
}

async function readActionDocument(file: string): Promise<Readonly<Record<string, unknown>>> {
  const source = await readFile(file, "utf8");
  if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error("journey_release_action_evidence_too_large");
  const lines = source.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) throw new Error("journey_release_action_evidence_entry_count_invalid");
  const value = JSON.parse(lines[0]!) as unknown;
  if (!isRecord(value)) throw new Error("journey_release_action_evidence_invalid");
  return value;
}

function validateHostCommands(value: unknown, cell: JourneyReleaseCellDeclaration): readonly HostCommandLedgerEntry[] {
  if (!Array.isArray(value)) throw new Error("journey_release_host_command_ledger_invalid");
  const observed = new Set<string>();
  for (const entry of value) {
    const keys = ["runtimeInstanceId", "uiIntentId", "commandId", "intentKind", "source"];
    if (!isRecord(entry)
      || Object.keys(entry).length !== keys.length
      || Object.keys(entry).some((key) => !keys.includes(key))
      || entry.runtimeInstanceId !== cell.lineage.runtimeInstanceId
      || typeof entry.uiIntentId !== "string" || !/^ui_intent_[A-Za-z0-9-]+$/u.test(entry.uiIntentId)
      || typeof entry.commandId !== "string" || !/^command_[A-Za-z0-9-]+$/u.test(entry.commandId)
      || typeof entry.intentKind !== "string" || !entry.intentKind
      || entry.source !== "authenticated_runtime_bridge"
      || observed.has(entry.commandId)) {
      throw new Error("journey_release_host_command_ledger_invalid");
    }
    observed.add(entry.commandId);
  }
  return Object.freeze(value.map((entry) => Object.freeze({ ...(entry as HostCommandLedgerEntry) })));
}

function validateHostOperations(
  value: unknown,
  cell: JourneyReleaseCellDeclaration,
  lineageId: string,
  cellMode: ControlledJourneyCellMode,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("journey_release_host_operation_ledger_invalid");
  let sequence = 0;
  for (const entry of value) {
    if (!isRecord(entry)
      || entry.schemaVersion !== 1
      || entry.evidenceClass !== "deterministic_fake"
      || entry.issuer !== "runtime_host"
      || entry.uiClaim !== false
      || entry.nativeClaim !== false
      || entry.runtimeInstanceId !== cell.lineage.runtimeInstanceId
      || entry.lineageId !== lineageId
      || entry.sequence !== ++sequence
      || typeof entry.kind !== "string"
      || typeof entry.observedAt !== "string") {
      throw new ReleaseCellWorkerBlockedError("controlled Host operation ledger did not preserve the Runtime anchor");
    }
    rejectUnsafeFactFields(entry, { nonce: "<not-present>" } as JourneyReleaseMatrix);
  }
  const operations = Object.freeze(value.map((entry) => Object.freeze({ ...(entry as Record<string, unknown>) })));
  if (cellMode === "main") validateControlledJ09OldGenerationRejection(operations);
  return operations;
}

export function validateControlledJ09OldGenerationRejection(
  operations: readonly Readonly<Record<string, unknown>>[],
): void {
  const exact = (predicate: (entry: Readonly<Record<string, unknown>>) => boolean, code: string) => {
    const matches = operations.filter(predicate);
    if (matches.length !== 1) throw new Error(code);
    return matches[0]!;
  };
  const generationOne = exact((entry) => entry.kind === "conductor_tool_result"
    && entry.checkpoint === "J-05"
    && entry.toolName === "invoke_agent"
    && entry.agentCardId === "agent_card_researcher"
    && entry.resultStatus === "session_created"
    && typeof entry.sessionId === "string", "journey_release_j09_generation_one_identity_missing");
  const close = exact((entry) => entry.kind === "conductor_tool_result"
    && entry.checkpoint === "J-09"
    && entry.toolName === "close_session"
    && entry.resultStatus === "closed"
    && entry.sessionId === generationOne.sessionId, "journey_release_j09_generation_one_close_missing");
  const generationTwo = exact((entry) => entry.kind === "conductor_tool_result"
    && entry.checkpoint === "J-09"
    && entry.toolName === "invoke_agent"
    && entry.agentCardId === "agent_card_researcher"
    && entry.resultStatus === "session_created"
    && typeof entry.sessionId === "string", "journey_release_j09_generation_two_identity_missing");
  const rejection = exact((entry) => entry.kind === "conductor_tool_result"
    && entry.checkpoint === "J-09"
    && entry.toolName === "send_to_session"
    && entry.sessionId === generationOne.sessionId
    && entry.resultStatus === "rejected"
    && entry.rejectionCode === "orchestration_session_not_current",
  "journey_release_j09_old_generation_rejection_missing");
  if (generationTwo.sessionId === generationOne.sessionId
    || typeof close.sequence !== "number"
    || typeof generationTwo.sequence !== "number"
    || typeof rejection.sequence !== "number"
    || !(close.sequence < generationTwo.sequence && generationTwo.sequence < rejection.sequence)) {
    throw new Error("journey_release_j09_old_generation_rejection_order_invalid");
  }
}

function validateControlledHealth(
  value: unknown,
  cell: JourneyReleaseCellDeclaration,
  cellMode: ControlledJourneyCellMode,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)
    || value.ready !== true
    || value.runtimeInstanceId !== cell.lineage.runtimeInstanceId
    || value.lineageId !== `session_id_controlled_lineage_${cell.lineage.runtimeInstanceId}`
    || value.cellMode !== cellMode
    || typeof value.generation !== "number"
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1) {
    throw new Error("journey_release_controlled_health_invalid");
  }
  return Object.freeze({
    ready: true,
    runtimeInstanceId: value.runtimeInstanceId,
    lineageId: value.lineageId,
    cellMode,
    generation: value.generation,
  });
}

function validateObservedLineage(value: unknown, cell: JourneyReleaseCellDeclaration): ObservedLineage {
  const arrayFields = [
    "templateDraftIds", "taskSetupDraftIds", "taskIds", "runIds", "metaSessionIds", "metaTurnIds",
    "cardSessionSlotIds", "logicalSessionIds", "bindingIds", "messageIds", "messageForwardIds",
    "humanInterventionIds", "inputSubmissionIds", "sessionTurnIds", "sessionControlAuditIds",
  ] as const;
  const prefixes: Readonly<Record<typeof arrayFields[number], string>> = Object.freeze({
    templateDraftIds: "template_draft",
    taskSetupDraftIds: "task_setup_draft",
    taskIds: "task",
    runIds: "run",
    metaSessionIds: "meta_session",
    metaTurnIds: "meta_turn",
    cardSessionSlotIds: "card_session_slot",
    logicalSessionIds: "logical_session",
    bindingIds: "binding",
    messageIds: "message",
    messageForwardIds: "message_forward",
    humanInterventionIds: "human_intervention",
    inputSubmissionIds: "input",
    sessionTurnIds: "session_turn",
    sessionControlAuditIds: "session_control",
  });
  const keys = ["schemaVersion", "runtimeInstanceId", ...arrayFields, "canonicalDigest"];
  if (!isRecord(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || value.schemaVersion !== 1
    || value.runtimeInstanceId !== cell.lineage.runtimeInstanceId
    || typeof value.canonicalDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.canonicalDigest)) {
    throw new Error("journey_release_observed_lineage_invalid");
  }
  for (const field of arrayFields) {
    const entries = value[field];
    const prefix = prefixes[field];
    const mayBeEmpty = field === "messageForwardIds"
      || field === "humanInterventionIds"
      || field === "sessionControlAuditIds";
    if (!Array.isArray(entries) || (!mayBeEmpty && entries.length === 0)
      || entries.some((entry) => typeof entry !== "string" || entry.length > 128
        || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(entry)
        || /(?:^|[-_])fallback(?:[-_]|$)/u.test(entry))) {
      throw new Error("journey_release_observed_lineage_invalid");
    }
  }
  const observed = value as unknown as ObservedLineage;
  const digestInput = Object.freeze(Object.fromEntries(
    keys.filter((key) => key !== "canonicalDigest").map((key) => [key, observed[key as keyof ObservedLineage]]),
  ));
  if (sessionIdObservedLineageDigest(digestInput as never) !== observed.canonicalDigest) {
    throw new Error("journey_release_observed_lineage_digest_mismatch");
  }
  const allIds = [
    observed.runtimeInstanceId,
    ...arrayFields.flatMap((field) => observed[field]),
  ];
  if (new Set(allIds).size !== allIds.length) throw new Error("journey_release_observed_lineage_duplicate");
  return Object.freeze(observed);
}

function validateReferencedLineageIds(value: unknown, observed: ObservedLineage): void {
  const byField: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
    runtimeInstanceId: new Set([observed.runtimeInstanceId]),
    templateDraftId: new Set(observed.templateDraftIds),
    taskSetupDraftId: new Set(observed.taskSetupDraftIds),
    taskId: new Set(observed.taskIds),
    runId: new Set(observed.runIds),
    metaSessionId: new Set(observed.metaSessionIds),
    metaTurnId: new Set(observed.metaTurnIds),
    cardSessionSlotId: new Set(observed.cardSessionSlotIds),
    logicalSessionId: new Set(observed.logicalSessionIds),
    sessionId: new Set(observed.logicalSessionIds),
    resultSessionId: new Set(observed.logicalSessionIds),
    sourceLogicalSessionId: new Set(observed.logicalSessionIds),
    targetLogicalSessionId: new Set(observed.logicalSessionIds),
    bindingId: new Set(observed.bindingIds),
    messageId: new Set(observed.messageIds),
    sourceMessageId: new Set(observed.messageIds),
    renderedMessageId: new Set(observed.messageIds),
    cardMessageId: new Set(observed.messageIds),
    conductorMirrorMessageId: new Set(observed.messageIds),
    forwardId: new Set(observed.messageForwardIds),
    humanInterventionId: new Set(observed.humanInterventionIds),
    inputSubmissionId: new Set(observed.inputSubmissionIds),
    sessionTurnId: new Set(observed.sessionTurnIds),
    sourceConductorSessionTurnId: new Set(observed.sessionTurnIds),
    sessionControlAuditId: new Set(observed.sessionControlAuditIds),
    controlId: new Set(observed.sessionControlAuditIds),
  });
  visit(value);

  function visit(candidate: unknown, field?: string): void {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, field?.endsWith("Ids") ? field.slice(0, -1) : field);
      return;
    }
    if (!isRecord(candidate)) {
      if (typeof candidate === "string" && field && byField[field] && !byField[field].has(candidate)) {
        throw new Error("journey_release_observed_lineage_reference_unknown");
      }
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) visit(entry, key);
  }
}

function validateControlledBranchOperations(
  operations: readonly Readonly<Record<string, unknown>>[],
  health: Readonly<Record<string, unknown>>,
  cellMode: ControlledJourneyCellMode,
): void {
  const branchOperations = operations.filter(({ kind }) =>
    kind === "branch_restart_point_ready"
    || kind === "branch_restart_resumed"
    || kind === "branch_outcome_staged");
  if (cellMode === "main") {
    if (branchOperations.length > 0) throw new Error("journey_release_main_cell_contains_branch_operation");
    return;
  }
  const expectedCrashPoint = cellMode.replace(/^j(?:08|10)-/u, "");
  if (branchOperations.some(({ cellMode: observed }) => observed !== cellMode)
    || branchOperations.some(({ crashPoint }) => crashPoint !== expectedCrashPoint)) {
    throw new Error("journey_release_branch_operation_identity_mismatch");
  }
  if (cellMode === "j08-late-final") {
    if (branchOperations.filter(({ kind }) => kind === "branch_outcome_staged").length !== 1
      || health.generation !== 1) {
      throw new Error("journey_release_late_final_operation_missing");
    }
    return;
  }
  for (const kind of ["branch_restart_point_ready", "branch_restart_resumed"] as const) {
    if (branchOperations.filter((entry) => entry.kind === kind).length !== 1) {
      throw new Error(`journey_release_branch_${kind}_missing`);
    }
  }
  if (!operations.some(({ kind }) => kind === "host_restart_requested")
    || !operations.some(({ kind }) => kind === "host_restart_completed")
    || typeof health.generation !== "number"
    || health.generation < 2) {
    throw new Error("journey_release_branch_restart_evidence_missing");
  }
}

async function emitControlledUiEvidence(input: Readonly<{
  matrix: JourneyReleaseMatrix;
  cell: JourneyReleaseCellDeclaration;
  outputDirectory: string;
  mode: "browser" | "desktop" | "cross";
  stateRoot: string;
  actionDocument: Readonly<Record<string, unknown>>;
  hostCommands: readonly HostCommandLedgerEntry[];
  hostOperations: readonly Readonly<Record<string, unknown>>[];
  health: Readonly<Record<string, unknown>>;
  observedLineage: ObservedLineage;
}>): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const bundles = actionBundles(input.actionDocument, input.mode, input.cell);
  validateJ09VisibleGenerationEvidence(bundles, input.hostOperations);
  const correlatedCommandIds = new Set(bundles.flatMap(({ correlations }) => correlations.map(({ commandId }) => commandId)));
  if (correlatedCommandIds.size !== input.hostCommands.length
    || input.hostCommands.some(({ commandId }) => !correlatedCommandIds.has(commandId))) {
    throw new Error("journey_release_ui_host_command_coverage_invalid");
  }
  const isolationAlias = `alias_cell_root_${createHash("sha256").update(input.stateRoot).digest("hex").slice(0, 20)}`;
  const streams: Readonly<Record<string, unknown>>[] = [];
  for (const bundle of bundles) {
    const requirement = exactRequirement(input.cell, bundle.issuer);
    validateUiActionBundle(bundle, input.cell, requirement);
    const ledgerFile = bundle.issuer === "browser_ui_driver" ? "browser-ui.json" : "electron-ui.json";
    await writePrivateJson(path.join(input.outputDirectory, ledgerFile), {
      schemaVersion: 1,
      releaseRunId: input.matrix.releaseRunId,
      nonce: input.matrix.nonce,
      bundleCellId: input.cell.bundleCellId,
      scenarioId: input.cell.scenarioId,
      runtimeInstanceId: input.cell.lineage.runtimeInstanceId,
      observedLineageDigest: input.observedLineage.canonicalDigest,
      isolationAlias,
      checkpointFacts: bundle.traces.map((trace) => ({
        checkpoint: trace.checkpoint,
        event: "visible_locator_action_completed",
        actionTraceId: trace.actionTraceId,
        intentKind: trace.intentKind,
        action: trace.action,
        target: trace.target,
        correlatedCommandIds: bundle.correlations
          .filter(({ actionTraceId }) => actionTraceId === trace.actionTraceId)
          .map(({ commandId }) => commandId),
      })),
    });
    streams.push(Object.freeze({
      issuer: bundle.issuer,
      journeyId: `journey_${input.cell.bundleCellId.slice("cell_".length)}`,
      outcome: "PASS",
      checkpoints: requirement.checkpoints,
      ledgerFile,
      observedLineageDigest: input.observedLineage.canonicalDigest,
      actionTraces: bundle.traces,
      actionCorrelations: bundle.correlations,
    }));
  }

  const runtimeRequirement = exactRequirement(input.cell, "runtime_host");
  const traces = bundles.flatMap(({ traces: entries }) => entries);
  const correlations = bundles.flatMap(({ correlations: entries }) => entries);
  const runtimeLedgerFile = "runtime-host.json";
  await writePrivateJson(path.join(input.outputDirectory, runtimeLedgerFile), {
    schemaVersion: 1,
    releaseRunId: input.matrix.releaseRunId,
    nonce: input.matrix.nonce,
    bundleCellId: input.cell.bundleCellId,
    scenarioId: input.cell.scenarioId,
    runtimeInstanceId: input.cell.lineage.runtimeInstanceId,
    isolationAlias,
    runtimeAnchor: input.cell.lineage,
    observedLineage: input.observedLineage,
    observedLineageDigest: input.observedLineage.canonicalDigest,
    health: input.health,
    hostCommands: input.hostCommands,
    hostOperations: input.hostOperations,
    checkpointFacts: runtimeRequirement.checkpoints.map((checkpoint) => ({
      checkpoint,
      event: "controlled_host_checkpoint_correlated",
      generation: input.health.generation,
      actionTraceIds: traces.filter((trace) => trace.checkpoint === checkpoint).map(({ actionTraceId }) => actionTraceId),
      commandIds: correlations.filter((entry) => entry.checkpoint === checkpoint).map(({ commandId }) => commandId),
      operationSequences: input.hostOperations
        .filter((entry) => operationCheckpoint(entry) === checkpoint)
        .map((entry) => entry.sequence),
    })),
  });
  streams.push(Object.freeze({
    issuer: "runtime_host",
    journeyId: `journey_${input.cell.bundleCellId.slice("cell_".length)}`,
    outcome: "PASS",
    checkpoints: runtimeRequirement.checkpoints,
    ledgerFile: runtimeLedgerFile,
    observedLineageDigest: input.observedLineage.canonicalDigest,
  }));
  return Object.freeze(streams);
}

function actionBundles(
  document: Readonly<Record<string, unknown>>,
  mode: "browser" | "desktop" | "cross",
  cell: JourneyReleaseCellDeclaration,
): readonly UiActionBundle[] {
  if (document.scenarioId !== cell.scenarioId) throw new Error("journey_release_action_scenario_mismatch");
  if (mode === "cross") {
    const keys = [
      "scenarioId", "browserTraces", "browserCorrelations", "electronTraces", "electronCorrelations",
    ];
    if (Object.keys(document).length !== keys.length || Object.keys(document).some((key) => !keys.includes(key))) {
      throw new Error("journey_release_cross_action_document_invalid");
    }
    return Object.freeze([
      toActionBundle("browser_ui_driver", document.browserTraces, document.browserCorrelations),
      toActionBundle("electron_ui_driver", document.electronTraces, document.electronCorrelations),
    ]);
  }
  const keys = ["scenarioId", "traces", "correlations"];
  if (Object.keys(document).length !== keys.length || Object.keys(document).some((key) => !keys.includes(key))) {
    throw new Error("journey_release_ui_action_document_invalid");
  }
  return Object.freeze([toActionBundle(
    mode === "browser" ? "browser_ui_driver" : "electron_ui_driver",
    document.traces,
    document.correlations,
  )]);
}

function toActionBundle(
  issuer: UiActionBundle["issuer"],
  traces: unknown,
  correlations: unknown,
): UiActionBundle {
  if (!Array.isArray(traces) || !Array.isArray(correlations)) throw new Error("journey_release_ui_action_document_invalid");
  return Object.freeze({
    issuer,
    traces: Object.freeze(traces as JourneyActionTrace[]),
    correlations: Object.freeze(correlations as ActionCommandCorrelation[]),
  });
}

function validateUiActionBundle(
  bundle: UiActionBundle,
  cell: JourneyReleaseCellDeclaration,
  requirement: JourneyStreamRequirement,
): void {
  if (bundle.traces.length === 0 || bundle.correlations.length === 0) {
    throw new Error("journey_release_ui_action_evidence_empty");
  }
  verifyActionCommandCorrelation(bundle.traces, bundle.correlations);
  for (const trace of bundle.traces) {
    if (trace.scenarioId !== cell.scenarioId) throw new Error("journey_release_ui_action_scenario_mismatch");
  }
  for (const correlation of bundle.correlations) {
    if (correlation.scenarioId !== cell.scenarioId
      || correlation.runtimeInstanceId !== cell.lineage.runtimeInstanceId) {
      throw new Error("journey_release_ui_action_lineage_mismatch");
    }
  }
  const observed = new Set(bundle.traces.map(({ checkpoint }) => checkpoint));
  const missing = requirement.checkpoints.filter((checkpoint) => !observed.has(checkpoint));
  if (missing.length > 0) {
    throw new ReleaseCellWorkerBlockedError(
      `${bundle.issuer} actual-operation scenario does not exercise ${missing.join(",")}`,
    );
  }
}

function validateJ09VisibleGenerationEvidence(
  bundles: readonly UiActionBundle[],
  operations: readonly Readonly<Record<string, unknown>>[],
): void {
  if (!operations.some((entry) => entry.kind === "conductor_tool_result"
    && entry.checkpoint === "J-09"
    && entry.toolName === "send_to_session"
    && entry.resultStatus === "rejected"
    && entry.rejectionCode === "orchestration_session_not_current")) return;
  const j09Targets = new Set(bundles.flatMap(({ traces }) => traces
    .filter(({ checkpoint }) => checkpoint === "J-09" && traces.length > 0)
    .map(({ target }) => target.by === "testId" ? target.value : undefined)
    .filter((value): value is string => typeof value === "string")));
  if (!j09Targets.has("session-researcher-g1-readonly")
    || !j09Targets.has("session-researcher-g2-current")) {
    throw new Error("journey_release_j09_visible_generation_evidence_missing");
  }
}

function operationCheckpoint(entry: Readonly<Record<string, unknown>>): FullJourneyCheckpoint | undefined {
  if (typeof entry.checkpoint === "string" && /^J-(?:0[1-9]|1[0-2])$/u.test(entry.checkpoint)) {
    return entry.checkpoint as FullJourneyCheckpoint;
  }
  if (entry.kind === "host_restart_requested" || entry.kind === "host_restart_completed") return "J-10";
  if (typeof entry.cellMode === "string") {
    if (entry.cellMode.startsWith("j08-")) return "J-08";
    if (entry.cellMode.startsWith("j10-")) return "J-10";
  }
  if (typeof entry.stage !== "string") return undefined;
  if (entry.stage.startsWith("j05_")) return "J-05";
  if (entry.stage.startsWith("j06_")) return "J-06";
  if (entry.stage.startsWith("j08_")) return "J-08";
  if (entry.stage.startsWith("j09_")) return "J-09";
  return undefined;
}

export async function fetchLoopbackJson(
  url: string,
  code: string,
  bearerToken?: string,
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {},
): Promise<unknown> {
  requireLoopbackUrl(url, code);
  const timeoutMs = options.timeoutMs ?? LOOPBACK_FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error(`${code}:timeout_invalid`);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(new Error("journey_release_worker_terminated"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${code}:timeout`));
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      ...(bearerToken ? { headers: { authorization: `Bearer ${bearerToken}` } } : {}),
    });
    if (!response.ok) throw new Error(`${code}:${response.status}`);
    const source = await response.text();
    if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new Error(`${code}:response_too_large`);
    try { return JSON.parse(source) as unknown; } catch { throw new Error(`${code}:invalid_json`); }
  } catch (error) {
    if (options.signal?.aborted) throw new Error("journey_release_worker_terminated");
    if (timedOut) throw new Error(`${code}:timeout`);
    if (error instanceof Error && error.message.startsWith(`${code}:`)) throw error;
    throw new Error(`${code}:request_failed`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The candidate is the last write. A live launcher cannot mint final evidence:
 * it must exit cleanly first, then the worker may reopen durable read-only truth.
 */
export async function finalizeCleanupFencedReleaseEvidence<TFinal, TWritten>(input: Readonly<{
  stateRoot: string;
  closeLauncher(): Promise<void>;
  readFinalEvidence(): Promise<TFinal>;
  writeLedgers(finalEvidence: TFinal): Promise<TWritten>;
  emitCandidate(written: TWritten, finalEvidence: TFinal): Promise<void>;
}>): Promise<void> {
  const initial = await lstat(input.stateRoot);
  if (!path.isAbsolute(input.stateRoot)
    || !initial.isDirectory()
    || initial.isSymbolicLink()
    || (platform() !== "win32" && ((initial.mode & 0o777) !== 0o700 || initial.uid !== process.getuid?.()))) {
    throw new Error("journey_release_state_root_invalid");
  }
  await input.closeLauncher();
  const finalEvidence = await input.readFinalEvidence();
  const written = await input.writeLedgers(finalEvidence);
  const current = await lstat(input.stateRoot);
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== initial.dev || current.ino !== initial.ino
    || (platform() !== "win32" && ((current.mode & 0o777) !== 0o700 || current.uid !== initial.uid))) {
    throw new Error("journey_release_state_root_drift");
  }
  await rm(input.stateRoot, { recursive: true });
  try {
    await lstat(input.stateRoot);
    throw new Error("journey_release_state_root_cleanup_unconfirmed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await input.emitCandidate(written, finalEvidence);
}

export function spawnBounded(
  executable: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string;
    environment: NodeJS.ProcessEnv;
    timeoutMs: number;
    terminationGraceMs?: number;
    signal?: AbortSignal;
  }>,
): Promise<Readonly<{ exitCode: number; diagnostic: string }>> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    return Promise.resolve(Object.freeze({ exitCode: 1, diagnostic: "child_process_timeout_invalid" }));
  }
  const terminationGraceMs = options.terminationGraceMs ?? CHILD_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    return Promise.resolve(Object.freeze({ exitCode: 1, diagnostic: "child_process_grace_invalid" }));
  }
  return new Promise((resolve) => {
    const child = spawnOwnedProcess(executable, args, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let outputBytes = 0;
    let diagnostic = "";
    let terminationReason: string | undefined;
    let settled = false;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => requestStop("child_process_aborted");
    const count = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      diagnostic = `${diagnostic}${String(chunk)}`.slice(-16_384);
      if (outputBytes > 4 * 1024 * 1024) requestStop("child_process_output_limit");
    };
    child.stdout?.on("data", count);
    child.stderr?.on("data", count);
    const timer = setTimeout(() => requestStop("child_process_timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.once("error", () => {
      void signalOwnedProcessTree(child, true)
        .finally(() => finish({ exitCode: 1, diagnostic: terminationReason ?? "child_process_error" }));
    });
    child.once("exit", (code, signal) => {
      void signalOwnedProcessTree(child, true).finally(() => finish({
        exitCode: terminationReason || signal ? 1 : (code ?? 1),
        diagnostic: terminationReason ?? safeChildDiagnostic(diagnostic),
      }));
    });

    function requestStop(reason: string): void {
      if (settled || terminationReason) return;
      terminationReason = reason;
      void signalOwnedProcessTree(child, false);
      hardStop = setTimeout(() => {
        void signalOwnedProcessTree(child, true).finally(() => finish({ exitCode: 1, diagnostic: reason }));
      }, terminationGraceMs);
    }

    function finish(result: Readonly<{ exitCode: number; diagnostic: string }>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(Object.freeze(result));
    }
  });
}

function safeChildDiagnostic(source: string): string {
  const lines = source.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(-12);
  const knownCode = [...source.matchAll(
    /journey_(?:visible_action_failed|visible_action_host_command_count_mismatch|visible_action_host_command_mismatch):J-(?:0[1-9]|1[0-2]):[^\s'"]+/gu,
  )].at(-1)?.[0];
  const diagnostic = lines.join(" | ")
    .replaceAll(REPOSITORY_ROOT, "<repository>")
    .replace(/https?:\/\/[^\s)'"]+/gu, "<loopback-url>")
    .replace(/[A-Za-z0-9_-]{40,}/gu, "<redacted>")
    .slice(0, 2_048) || "no_child_diagnostic";
  return knownCode ? `${knownCode} | ${diagnostic}` : diagnostic;
}

export function safeReleaseFailureCode(
  error: unknown,
  fallback = "journey_release_cell_failed",
): string {
  const source = error instanceof Error ? error.message : String(error);
  return extractSafeReleaseFailureCode(source) ?? fallback;
}

function extractSafeReleaseFailureCode(source: string): string | undefined {
  const providerCode = [...source.matchAll(SAFE_PROVIDER_FAILURE_CODE_IN_TEXT)].at(-1)?.[1];
  if (providerCode && isSafeReleaseFailureCode(providerCode)) return providerCode;
  const boundaryCode = [...source.matchAll(SAFE_BOUNDARY_FAILURE_CODE_IN_TEXT)].at(-1)?.[1];
  return boundaryCode && isSafeReleaseFailureCode(boundaryCode) ? boundaryCode : undefined;
}

function safeStructuredReleaseFailure(
  line: string,
): Readonly<{ code?: string; blocked: boolean }> {
  if (!line || line.length > 4_096) return Object.freeze({ blocked: false });
  let value: unknown;
  try { value = JSON.parse(line); } catch { return Object.freeze({ blocked: false }); }
  if (!isRecord(value)) return Object.freeze({ blocked: false });
  const serviceFailure = value.type === "native_unified_host_failure"
    && value.outcome === "FAIL"
    && ["managed_core", "scoped_tools", "service_start"].includes(
      typeof value.stage === "string" ? value.stage : "",
    );
  const launcherFailure = value.type === "native_release_cell_failure"
    && (value.outcome === "FAIL" || value.outcome === "BLOCKED_CAPABILITY")
    && ["managed_core", "scoped_tools", "service_start", "preflight", "release_cell"].includes(
      typeof value.stage === "string" ? value.stage : "",
    );
  if (Object.keys(value).sort().join(",") !== "code,outcome,stage,type"
    || (!serviceFailure && !launcherFailure)
    || typeof value.code !== "string"
    || !isSafeReleaseFailureCode(value.code)) return Object.freeze({ blocked: false });
  return Object.freeze({ code: value.code, blocked: value.outcome === "BLOCKED_CAPABILITY" });
}

function isSafeReleaseFailureCode(value: string): boolean {
  return value.length <= 192 && SAFE_RELEASE_FAILURE_CODE.test(value);
}

export async function stopChild(
  child: ChildProcess,
  options: Readonly<{ terminationGraceMs?: number }> = {},
): Promise<void> {
  const pid = child.pid;
  if (!pid) throw new Error("journey_release_launcher_process_unconfirmed");
  const terminationGraceMs = options.terminationGraceMs ?? CHILD_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new Error("journey_release_launcher_termination_grace_invalid");
  }

  let result: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error: boolean;
  }> | undefined = child.exitCode !== null || child.signalCode !== null
    ? Object.freeze({ code: child.exitCode, signal: child.signalCode, error: false })
    : undefined;
  if (!result) {
    const exited = waitForChildExit(child);
    await signalOwnedProcessTree(child, false);
    result = await Promise.race([
      exited,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), terminationGraceMs)),
    ]);
    if (!result) {
      await signalOwnedProcessTree(child, true);
      await Promise.race([
        exited,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), terminationGraceMs)),
      ]);
      await waitForOwnedProcessTreeGone(pid, terminationGraceMs).catch(() => undefined);
      throw new Error("journey_release_launcher_forced_termination");
    }
  }
  if (result.error || result.code !== 0 || result.signal !== null) {
    await signalOwnedProcessTree(child, true);
    await waitForOwnedProcessTreeGone(pid, terminationGraceMs).catch(() => undefined);
    throw new Error("journey_release_launcher_exit_invalid");
  }
  try {
    await waitForOwnedProcessTreeGone(pid, terminationGraceMs);
  } catch {
    await signalOwnedProcessTree(child, true);
    await waitForOwnedProcessTreeGone(pid, terminationGraceMs).catch(() => undefined);
    throw new Error("journey_release_launcher_forced_termination");
  }
}

function waitForChildExit(
  child: ChildProcess,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null; error: boolean }>> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(Object.freeze({ code: child.exitCode, signal: child.signalCode, error: false }));
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(Object.freeze({ code, signal, error: false })));
    child.once("error", () => resolve(Object.freeze({ code: null, signal: null, error: true })));
  });
}

async function waitForOwnedProcessTreeGone(pid: number, timeoutMs: number): Promise<void> {
  if (platform() === "win32") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("journey_release_launcher_process_tree_alive");
}

function spawnOwnedProcess(
  executable: string,
  args: readonly string[],
  options: NonNullable<Parameters<typeof spawn>[2]>,
): ChildProcess {
  const child = spawn(executable, [...args], {
    ...options,
    detached: platform() !== "win32",
  });
  announceOwnedProcessTree(child, "started");
  const stopped = () => announceOwnedProcessTree(child, "stopped");
  child.once("exit", stopped);
  child.once("error", stopped);
  return child;
}

function announceOwnedProcessTree(child: ChildProcess, state: "started" | "stopped"): void {
  if (!child.pid || typeof process.send !== "function") return;
  try {
    process.send(Object.freeze({ type: "release_cell_process_tree", state, pid: child.pid }));
  } catch {
    // Process-tree audit messages are cleanup hints; the local owner still closes the child.
  }
}

async function signalOwnedProcessTree(child: ChildProcess, force: boolean): Promise<void> {
  if (!child.pid || (!force && (child.exitCode !== null || child.signalCode !== null))) return;
  if (platform() === "win32") {
    await taskkillBounded(child.pid, force);
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* already gone */ }
    }
  }
}

function taskkillBounded(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(executable, ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(finish, 2_000);
    killer.once("exit", finish);
    killer.once("error", finish);
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { killer.kill("SIGKILL"); } catch { /* already gone */ }
      resolve();
    }
  });
}

function requireLoopbackUrl(value: unknown, code: string): URL {
  if (typeof value !== "string") throw new Error(code);
  const url = new URL(value);
  if (url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.hash) {
    throw new Error(code);
  }
  return url;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function requireRegularFile(value: string, code: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error(code);
  const status = await lstat(value);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(code);
  return path.resolve(value);
}

async function requireExecutable(value: string, code: string): Promise<string> {
  const file = await requireRegularFile(value, code);
  const status = await lstat(file);
  if ((status.mode & 0o777) !== 0o700) throw new Error(code);
  return file;
}

async function runBridgeCell(
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
  outputDirectory: string,
  cellMode: DeterministicSessionIdCellMode,
): Promise<void> {
  const requirement = exactRequirement(cell, "runtime_host");
  const result = await runDeterministicSessionIdJourneyCell({
    runtimeInstanceId: cell.lineage.runtimeInstanceId,
    scenarioId: cell.scenarioId,
    cellMode,
    lineage: cell.lineage,
  });
  try {
    const fixtureRoot = await requirePrivateAbsoluteDirectory(result.fixtureRoot, "journey_release_bridge_fixture_root_invalid");
    const hostLedgerFile = await requirePrivateAbsoluteFile(result.hostLedgerFile, "journey_release_bridge_ledger_invalid");
    if (path.dirname(hostLedgerFile) !== fixtureRoot) throw new Error("journey_release_bridge_ledger_scope_invalid");
    const checkpointFacts = parseHostLedger(await readFile(hostLedgerFile, "utf8"), matrix, cell, requirement.checkpoints);
    const observedLineage = validateObservedLineage(result.observedLineage, cell);
    validateReferencedLineageIds(checkpointFacts, observedLineage);
    const isolationAlias = `alias_cell_root_${createHash("sha256").update(fixtureRoot).digest("hex").slice(0, 20)}`;
    const ledgerFile = "runtime-host.json";
    await writePrivateJson(path.join(outputDirectory, ledgerFile), {
      schemaVersion: 1,
      releaseRunId: matrix.releaseRunId,
      nonce: matrix.nonce,
      bundleCellId: cell.bundleCellId,
      scenarioId: cell.scenarioId,
      runtimeInstanceId: cell.lineage.runtimeInstanceId,
      observedLineageDigest: observedLineage.canonicalDigest,
      isolationAlias,
      checkpointFacts,
    });
    await writeCandidate(outputDirectory, matrix, cell, [{
      issuer: "runtime_host",
      journeyId: `journey_${cell.bundleCellId.slice("cell_".length)}`,
      outcome: "PASS",
      checkpoints: requirement.checkpoints,
      ledgerFile,
      observedLineageDigest: observedLineage.canonicalDigest,
    }], observedLineage);
  } finally {
    await rm(result.fixtureRoot, { recursive: true, force: true });
  }
}

function parseHostLedger(
  source: string,
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
  expectedCheckpoints: readonly FullJourneyCheckpoint[],
): readonly Readonly<Record<string, unknown>>[] {
  const facts = source.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (facts.length === 0) throw new Error("journey_release_bridge_ledger_empty");
  const observed = new Set<string>();
  let previousSequence = 0;
  for (const fact of facts) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)
      || fact.runtimeInstanceId !== cell.lineage.runtimeInstanceId
      || fact.scenarioId !== cell.scenarioId
      || fact.evidenceClass !== "deterministic_fake"
      || fact.issuer !== "runtime_host"
      || fact.surface !== "runtime_bridge"
      || fact.uiClaim !== false
      || fact.nativeClaim !== false
      || typeof fact.sequence !== "number"
      || fact.sequence !== previousSequence + 1
      || typeof fact.checkpoint !== "string"
      || !FULL_JOURNEY_CHECKPOINTS.includes(fact.checkpoint as FullJourneyCheckpoint)) {
      throw new Error("journey_release_bridge_ledger_fact_invalid");
    }
    previousSequence = fact.sequence;
    observed.add(fact.checkpoint);
    rejectUnsafeFactFields(fact, matrix);
  }
  if (expectedCheckpoints.some((checkpoint) => !observed.has(checkpoint))) {
    throw new Error("journey_release_bridge_checkpoint_missing");
  }
  return Object.freeze(facts
    .filter((fact) => expectedCheckpoints.includes(fact.checkpoint as FullJourneyCheckpoint))
    .map((fact) => Object.freeze({ ...fact })));
}

function rejectUnsafeFactFields(value: unknown, matrix: JourneyReleaseMatrix): void {
  if (Array.isArray(value)) return value.forEach((entry) => rejectUnsafeFactFields(entry, matrix));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      if (value === matrix.nonce || /^Bearer\s/u.test(value) || /(?:^|[_-])(?:secret|password|api[-_]?key)(?:$|[_-])/iu.test(value)) {
        throw new Error("journey_release_bridge_ledger_secret_forbidden");
      }
      if (path.isAbsolute(value)) throw new Error("journey_release_bridge_ledger_absolute_path_forbidden");
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:authorization|cookie|password|secret|token|credential)$/iu.test(key)) {
      throw new Error("journey_release_bridge_ledger_secret_forbidden");
    }
    rejectUnsafeFactFields(entry, matrix);
  }
}

function validateFrozenMatrix(matrix: JourneyReleaseMatrix): void {
  if (!matrix || typeof matrix !== "object" || !Array.isArray(matrix.cells) || matrix.cells.length !== CELL_NAMES.length) {
    throw new Error("journey_release_worker_matrix_not_frozen_28_cells");
  }
  const byName = new Map<string, JourneyReleaseCellDeclaration>();
  for (const cell of matrix.cells) {
    if (!ALLOWED_CELLS.has(cell.bundleCellId)
      || cell.scenarioId !== `scenario_${cell.bundleCellId.slice("cell_".length)}`
      || cell.required !== true
      || byName.has(cell.bundleCellId)) {
      throw new Error("journey_release_worker_cell_declaration_invalid");
    }
    byName.set(cell.bundleCellId, cell);
  }
  if (byName.size !== CELL_NAMES.length) throw new Error("journey_release_worker_cell_declaration_invalid");
  validateCrossCellLineage([...byName.values()]);
  const expected = createRequiredJourneyReleaseMatrix(matrix, (cellName) => {
    const cell = byName.get(`cell_${cellName}`);
    if (!cell) throw new Error("journey_release_worker_cell_declaration_invalid");
    return cell.lineage;
  });
  if (!isDeepStrictEqual(matrix, expected)) throw new Error("journey_release_worker_matrix_contract_invalid");
}

function validateCrossCellLineage(cells: readonly JourneyReleaseCellDeclaration[]): void {
  const identities = new Set<string>();
  for (const cell of cells) {
    for (const identity of lineageIdentities(cell.lineage)) {
      if (identities.has(identity)) throw new Error("journey_release_worker_cross_cell_lineage_reused");
      identities.add(identity);
    }
  }
}

function lineageIdentities(lineage: JourneyEvidenceLineage): readonly string[] {
  return Object.freeze([lineage.runtimeInstanceId]);
}

function requiredCell(matrix: JourneyReleaseMatrix, cellId: string, scenarioId: string): JourneyReleaseCellDeclaration {
  if (!ALLOWED_CELLS.has(cellId)) throw new Error("journey_release_worker_cell_not_allowed");
  const cell = matrix.cells.find((candidate) => candidate.bundleCellId === cellId && candidate.scenarioId === scenarioId);
  if (!cell) throw new Error("journey_release_worker_cell_scenario_mismatch");
  return cell;
}

function exactRequirement(cell: JourneyReleaseCellDeclaration, issuer: ReleaseIssuer): JourneyStreamRequirement {
  const matches = cell.streamRequirements.filter((requirement) => requirement.issuer === issuer);
  if (matches.length !== 1) throw new Error("journey_release_worker_stream_requirement_invalid");
  return matches[0]!;
}

function validateEnvironmentIdentity(
  environment: NodeJS.ProcessEnv,
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
): void {
  const expected = {
    AGENT_WORKSPACE_RELEASE_RUN_ID: matrix.releaseRunId,
    AGENT_WORKSPACE_RELEASE_NONCE: matrix.nonce,
    AGENT_WORKSPACE_RELEASE_CELL_ID: cell.bundleCellId,
    AGENT_WORKSPACE_RELEASE_SCENARIO_ID: cell.scenarioId,
  };
  if (Object.entries(expected).some(([key, value]) => environment[key] !== value)) {
    throw new Error("journey_release_worker_environment_identity_mismatch");
  }
}

async function writeCandidate(
  outputDirectory: string,
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
  streams: readonly Readonly<Record<string, unknown>>[],
  observedLineage?: ObservedLineage,
): Promise<void> {
  await writePrivateJson(path.join(outputDirectory, "candidate.json"), {
    schemaVersion: 1,
    releaseRunId: matrix.releaseRunId,
    nonce: matrix.nonce,
    bundleCellId: cell.bundleCellId,
    scenarioId: cell.scenarioId,
    lineage: cell.lineage,
    ...(observedLineage ? {
      observedLineage,
      observedLineageDigest: observedLineage.canonicalDigest,
    } : {}),
    streams,
  });
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(file, 0o600);
}

async function requirePrivateAbsoluteFile(value: string, code: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error(code);
  const status = await lstat(value);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o600) throw new Error(code);
  return path.resolve(value);
}

async function requirePrivateAbsoluteDirectory(value: string, code: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error(code);
  const status = await lstat(value);
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700) throw new Error(code);
  return path.resolve(value);
}

/** macOS tmpdir commonly aliases /var to /private/var; children receive only the canonical path. */
export async function createCanonicalPrivateTempRoot(prefix: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(prefix)) {
    throw new Error("journey_release_temp_root_prefix_invalid");
  }
  const requested = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(requested, 0o700);
  const canonical = await realpath(requested);
  const [requestedMetadata, canonicalMetadata] = await Promise.all([
    lstat(requested),
    lstat(canonical),
  ]);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!path.isAbsolute(canonical)
    || !requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()
    || !canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink()
    || requestedMetadata.dev !== canonicalMetadata.dev
    || requestedMetadata.ino !== canonicalMetadata.ino
    || (process.platform !== "win32" && (canonicalMetadata.mode & 0o777) !== 0o700)
    || (uid !== undefined && canonicalMetadata.uid !== uid)) {
    throw new Error("journey_release_temp_root_invalid");
  }
  return canonical;
}

async function requireEmptyPrivateOutput(value: string, cellId: string): Promise<string> {
  const output = await requirePrivateAbsoluteDirectory(value, "journey_release_worker_output_path_invalid");
  if (path.basename(output) !== cellId || (await readdir(output)).length !== 0) {
    throw new Error("journey_release_worker_output_path_invalid");
  }
  return output;
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]!);
}

function parseArguments(argv: readonly string[]): ReleaseCellWorkerInput {
  const expected = ["--matrix", "--cell", "--scenario", "--output"] as const;
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)) {
    throw new Error("journey_release_worker_arguments_invalid");
  }
  return Object.freeze({
    matrixFile: argv[1]!,
    cellId: argv[3]!,
    scenarioId: argv[5]!,
    outputDirectory: argv[7]!,
  });
}

if (isMainModule()) {
  const shutdown = new AbortController();
  const requestShutdown = () => {
    if (!shutdown.signal.aborted) shutdown.abort(new Error("journey_release_worker_terminated"));
  };
  const onMessage = (message: unknown) => {
    if (isRecord(message)
      && Object.keys(message).length === 1
      && message.type === "release_cell_shutdown") requestShutdown();
  };
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  process.on("message", onMessage);
  try {
    await runReleaseCellWorker({
      ...parseArguments(process.argv.slice(2)),
      signal: shutdown.signal,
    });
  } catch (error) {
    if (error instanceof ReleaseCellWorkerBlockedError) {
      process.stderr.write(`${JSON.stringify({
        outcome: "BLOCKED_CAPABILITY",
        reason: safeReleaseFailureCode(error, "journey_release_blocked_capability"),
      })}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${JSON.stringify({ outcome: "FAIL", code: safeReleaseFailureCode(error) })}\n`);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("message", onMessage);
    if (process.connected) process.disconnect();
  }
}
