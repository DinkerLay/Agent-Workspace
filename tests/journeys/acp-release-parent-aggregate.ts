import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertProductionReleaseDigests,
  productionReleaseIdentityInputBytes,
} from "../../scripts/production-release-inputs.mjs";
import {
  browserLinearScenario,
  CONTROLLED_UI_BRANCH_CELL_MODES,
  controlledUiBranchScenario,
  createAcpMetaJourneyScenario,
  createAcpTaskJourneyScenarios,
  crossSurfaceBrowserScenario,
  crossSurfaceElectronScenario,
  electronLinearScenario,
} from "./full-journey.scenario.js";
import {
  inspectProductionLocatorCoverage,
  verifyScenarioSourceSafety,
} from "./locator-action-dsl.js";
import {
  createAcpReleaseParentInputSeal,
  type AcpReleaseParentInputSeal,
} from "./acp-release-parent-preflight.js";
import {
  createAcpReleaseParentProductionQualificationSeal,
  verifyFrozenAcpReleaseParentQualificationSeal,
  type AcpReleaseParentQualificationSeal,
} from "./acp-release-parent-qualification.js";
import {
  createReleaseLocalGateIsolation,
  executeReleaseLocalGate,
  executeReleaseProductionBuild,
  runReleasePreparation,
  type ReleaseLocalGateIsolation,
} from "./release-preparation.js";
import { createRunnerOwnedEvidenceContext } from "./evidence-issuers.js";
import { runAndAttestReleaseCells } from "./release-cell-runner.js";
import {
  createFreshReleaseIdentity,
  createRequiredJourneyReleaseMatrix,
  verifyReleaseBundle,
} from "./release-verifier.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUNNER_EXECUTABLE = path.join(REPOSITORY_ROOT, "scripts", "release-cell-executor.mjs");
const WORKER_SOURCE = path.join(REPOSITORY_ROOT, "tests", "journeys", "release-cell-worker.ts");
const RELEASE_SUBPROCESS_TIMEOUT_MS = 1_800_000;
const RELEASE_SUBPROCESS_TERMINATION_GRACE_MS = 5_000;

export type AcpReleaseParentProductionResult = Readonly<{
  schemaVersion: 1;
  outcome: "PASS";
  releaseRunId: string;
  requiredCells: 28;
  attestations: number;
  evidenceRoot: string;
}>;

/**
 * The one production Phase 8 parent. It has no caller-supplied factory,
 * qualification, gate, build, runner or evidence issuer seam.
 */
export async function runAcpReleaseParentProduction(): Promise<AcpReleaseParentProductionResult> {
  let releaseRoot: string | undefined;
  let localGateIsolation: ReleaseLocalGateIsolation | undefined;
  let executionStarted = false;
  try {
    const qualificationSeal = await runReleasePreparation({
      preflight: qualifyCurrentProductionInputs,
      verifyFrozenPreflight: verifyFrozenAcpReleaseParentQualificationSeal,
      prepareLocalGateIsolation: async () => {
        releaseRoot = await createCanonicalPrivateTempDirectory("agent-workspace-acp-release-");
        localGateIsolation = await createReleaseLocalGateIsolation({ releaseRoot });
        return localGateIsolation;
      },
      runLocalGate: async (script, isolation) => executeReleaseLocalGate(script, {
        sourceEnvironment: process.env,
        isolation,
        execute: (invocation) => runReleaseSubprocess(invocation),
      }),
      verifyJourneyLocators: verifyAllProductionLocatorCoverage,
      build: async () => {
        if (!releaseRoot || !localGateIsolation) throw new Error("acp_release_parent_root_missing");
        const exitCode = await executeReleaseProductionBuild({
          sourceEnvironment: process.env,
          isolation: localGateIsolation,
          execute: (invocation) => runReleaseSubprocess(invocation),
        });
        if (exitCode !== 0) throw new Error("acp_release_parent_build_failed");
      },
    });
    if (!releaseRoot) throw new Error("acp_release_parent_root_missing");
    executionStarted = true;
    return await freezeRunAndVerifyRelease(qualificationSeal, releaseRoot);
  } catch (error) {
    if (releaseRoot && !executionStarted) await removeOwnedRootOrThrow(releaseRoot);
    throw error;
  }
}

async function qualifyCurrentProductionInputs(): Promise<AcpReleaseParentQualificationSeal> {
  const inputSeal: AcpReleaseParentInputSeal = await createAcpReleaseParentInputSeal();
  const parent = await createCanonicalPrivateTempDirectory("agent-workspace-acp-qualification-");
  const qualificationRoot = path.join(parent, "qualification");
  try {
    const seal = await createAcpReleaseParentProductionQualificationSeal({
      inputSeal,
      qualificationRoot,
    });
    await removeEmptyQualificationParent(parent, qualificationRoot, undefined);
    return seal;
  } catch (error) {
    await removeEmptyQualificationParent(parent, qualificationRoot, error);
    throw error;
  }
}

async function freezeRunAndVerifyRelease(
  qualificationSeal: AcpReleaseParentQualificationSeal,
  releaseRoot: string,
): Promise<AcpReleaseParentProductionResult> {
  await verifyFrozenAcpReleaseParentQualificationSeal(qualificationSeal);
  const runnerSha256 = await digestRegularFile(RUNNER_EXECUTABLE);
  const workerSha256 = await digestRegularFile(WORKER_SOURCE);
  const identityBytes = await productionReleaseIdentityInputBytes(REPOSITORY_ROOT, {
    runnerSha256,
    workerSha256,
  });
  const release = createFreshReleaseIdentity(identityBytes);
  const matrix = createRequiredJourneyReleaseMatrix(release);
  const matrixFile = path.join(releaseRoot, "matrix.json");
  const evidenceRoot = path.join(releaseRoot, "evidence");
  const matrixBytes = Buffer.from(`${JSON.stringify(matrix)}\n`, "utf8");
  await writeFile(matrixFile, matrixBytes, { mode: 0o600, flag: "wx" });
  await chmod(matrixFile, 0o600);
  await mkdir(evidenceRoot, { mode: 0o700 });
  await chmod(evidenceRoot, 0o700);
  const matrixIdentity = await privateFileIdentity(matrixFile, matrixBytes);
  const context = createRunnerOwnedEvidenceContext(matrix);
  const verifyReleaseInputs = async (): Promise<void> => {
    await verifyFrozenAcpReleaseParentQualificationSeal(qualificationSeal);
    if (await digestRegularFile(RUNNER_EXECUTABLE) !== runnerSha256
      || await digestRegularFile(WORKER_SOURCE) !== workerSha256) {
      throw new Error("journey_release_runner_source_drift");
    }
    await assertProductionReleaseDigests({
      repositoryRoot: REPOSITORY_ROOT,
      expected: matrix.digests,
      runnerSha256,
      workerSha256,
    });
    await assertPrivateFileCurrent(matrixFile, matrixBytes, matrixIdentity);
  };
  await verifyReleaseInputs();
  const attestations = await runAndAttestReleaseCells({
    matrix,
    matrixFile,
    evidenceRoot,
    runnerExecutable: RUNNER_EXECUTABLE,
    runnerSha256,
    runnerEnvironment: Object.freeze({
      AGENT_WORKSPACE_RELEASE_CELL_RUNNER_SHA256: runnerSha256,
      AGENT_WORKSPACE_RELEASE_CELL_WORKER_SHA256: workerSha256,
    }),
    issuerContext: context,
    verifyReleaseInputs,
  });
  await verifyReleaseInputs();
  const verification = verifyReleaseBundle({ matrix, attestations, verifier: context.verifier });
  if (verification.requiredCells !== 28) throw new Error("journey_release_matrix_not_exact_28");
  return Object.freeze({
    schemaVersion: 1,
    outcome: "PASS",
    releaseRunId: verification.releaseRunId,
    requiredCells: 28,
    attestations: verification.attestations,
    evidenceRoot,
  });
}

async function verifyAllProductionLocatorCoverage(): Promise<void> {
  await verifyScenarioSourceSafety(path.join(REPOSITORY_ROOT, "tests", "journeys"));
  const openCode = createAcpTaskJourneyScenarios({ providerFamily: "opencode", model: "release-locator-model" });
  const codex = createAcpTaskJourneyScenarios({ providerFamily: "codex", model: "release-locator-model" });
  const scenarios = [
    browserLinearScenario,
    electronLinearScenario,
    crossSurfaceBrowserScenario,
    crossSurfaceElectronScenario,
    ...CONTROLLED_UI_BRANCH_CELL_MODES.flatMap((mode) => [
      controlledUiBranchScenario("browser", mode),
      controlledUiBranchScenario("electron", mode),
    ]),
    openCode.browser,
    openCode.electron,
    codex.browser,
    codex.electron,
    createAcpMetaJourneyScenario({ metaProfileOptionId: "meta_profile_option_release_locator" }),
  ];
  const coverage = await inspectProductionLocatorCoverage({
    productionRoots: [
      path.join(REPOSITORY_ROOT, "apps", "workbench", "src"),
      path.join(REPOSITORY_ROOT, "packages", "workbench-ui", "src"),
    ],
    scenarios,
  });
  if (coverage.missingTestIds.length > 0) {
    throw new Error("journey_release_production_locator_coverage_incomplete");
  }
}

async function runReleaseSubprocess(invocation: Readonly<{
  executable: string;
  args: readonly string[];
  environment: Readonly<NodeJS.ProcessEnv>;
}>, timing: Readonly<{
  timeoutMs: number;
  terminationGraceMs: number;
}> = Object.freeze({
  timeoutMs: RELEASE_SUBPROCESS_TIMEOUT_MS,
  terminationGraceMs: RELEASE_SUBPROCESS_TERMINATION_GRACE_MS,
})): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, [...invocation.args], {
      cwd: REPOSITORY_ROOT,
      env: invocation.environment,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let settled = false;
    let timedOut = false;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    let killConfirmation: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      hardStop = setTimeout(() => {
        terminate("SIGKILL");
        killConfirmation = setTimeout(() => {
          finish(new Error("acp_release_parent_subprocess_cleanup_unconfirmed"));
        }, timing.terminationGraceMs);
      }, timing.terminationGraceMs);
    }, timing.timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(undefined, signal ? 1 : (code ?? 1)));

    function terminate(signal: NodeJS.Signals): void {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* exit handler remains authoritative */ }
    }
    function finish(error?: Error, exitCode?: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardStop) clearTimeout(hardStop);
      if (killConfirmation) clearTimeout(killConfirmation);
      if (error) reject(error);
      else resolve(timedOut ? 1 : (exitCode ?? 1));
    }
  });
}

/** Test-only timing seam; production always uses the fixed budgets above. */
export function runAcpReleaseParentSubprocessWithTimingForTest(
  invocation: Readonly<{
    executable: string;
    args: readonly string[];
    environment: Readonly<NodeJS.ProcessEnv>;
  }>,
  timing: Readonly<{ timeoutMs: number; terminationGraceMs: number }>,
): Promise<number> {
  if (!Number.isSafeInteger(timing.timeoutMs) || timing.timeoutMs < 1
    || !Number.isSafeInteger(timing.terminationGraceMs) || timing.terminationGraceMs < 1) {
    throw new Error("acp_release_parent_subprocess_timing_invalid");
  }
  return runReleaseSubprocess(invocation, timing);
}

async function createCanonicalPrivateTempDirectory(prefix: string): Promise<string> {
  const requested = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(requested, 0o700);
  const canonical = await realpath(requested);
  const [requestedMetadata, canonicalMetadata] = await Promise.all([lstat(requested), lstat(canonical)]);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!path.isAbsolute(canonical)
    || !requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()
    || !canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink()
    || requestedMetadata.dev !== canonicalMetadata.dev || requestedMetadata.ino !== canonicalMetadata.ino
    || (process.platform !== "win32" && (canonicalMetadata.mode & 0o777) !== 0o700)
    || (uid !== undefined && canonicalMetadata.uid !== uid)) {
    throw new Error("acp_release_parent_temp_root_invalid");
  }
  return canonical;
}

async function removeEmptyQualificationParent(
  parent: string,
  qualificationRoot: string,
  primary: unknown,
): Promise<void> {
  const childExists = await lstat(qualificationRoot).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (childExists) {
    if (primary instanceof Error && primary.message.includes("cleanup_unconfirmed")) return;
    throw new Error("acp_release_parent_qualification_cleanup_unconfirmed");
  }
  try {
    await rmdir(parent);
  } catch {
    throw new Error("acp_release_parent_qualification_cleanup_unconfirmed");
  }
}

async function removeOwnedRootOrThrow(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: false });
    const remains = await lstat(root).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
    if (remains) throw new Error("acp_release_parent_root_cleanup_unconfirmed");
  } catch {
    throw new Error("acp_release_parent_root_cleanup_unconfirmed");
  }
}

async function digestRegularFile(file: string): Promise<string> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("journey_release_source_file_invalid");
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

type FileIdentity = Readonly<{ dev: number; ino: number }>;

async function privateFileIdentity(file: string, expected: Buffer): Promise<FileIdentity> {
  const metadata = await lstat(file);
  const canonical = await realpath(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!metadata.isFile() || metadata.isSymbolicLink() || canonical !== file
    || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)
    || (uid !== undefined && metadata.uid !== uid)
    || !Buffer.from(await readFile(file)).equals(expected)) {
    throw new Error("journey_release_matrix_file_invalid");
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

async function assertPrivateFileCurrent(file: string, expected: Buffer, identity: FileIdentity): Promise<void> {
  const current = await privateFileIdentity(file, expected);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("journey_release_matrix_file_drift");
  }
}
