import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sessionIdObservedLineageDigest } from "../../apps/runtime-host/src/session-id-observed-lineage.js";
import {
  assertEvidenceSafe,
  type FullJourneyCheckpoint,
  type JourneyEvidenceIssuer,
  type JourneyEvidenceLineage,
  type JourneyOutcome,
} from "../e2e/journey-evidence.js";
import {
  type JourneyReleaseCellDeclaration,
  type JourneyReleaseMatrix,
  type RunnerOwnedEvidenceContext,
  type RunnerOwnedEvidenceIssuer,
  type TrustedJourneyAttestation,
} from "./evidence-issuers.js";
import type { ActionCommandCorrelation, JourneyActionTrace } from "./locator-action-dsl.js";
import {
  isAcpReleaseAttestorIssuer,
  validateAcpReleaseAttestationDocument,
} from "./acp-release-attestation.js";
import { ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS } from "./support/acp-release-cell-launcher.js";

type ReleaseIssuer = Exclude<JourneyEvidenceIssuer, "superseded_protocol_fixture">;

type ReleaseCellCandidate = Readonly<{
  schemaVersion: 1;
  releaseRunId: string;
  nonce: string;
  bundleCellId: string;
  scenarioId: string;
  lineage: JourneyEvidenceLineage;
  observedLineage?: ObservedLineage;
  observedLineageDigest?: string;
  streams: readonly ReleaseStreamCandidate[];
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

type ReleaseStreamCandidate = Readonly<{
  issuer: ReleaseIssuer;
  journeyId: string;
  outcome: JourneyOutcome;
  checkpoints: readonly FullJourneyCheckpoint[];
  ledgerFile: string;
  observedLineageDigest?: string;
  actionTraces?: readonly JourneyActionTrace[];
  actionCorrelations?: readonly ActionCommandCorrelation[];
}>;

export class ReleaseCellBlockedError extends Error {}

export const CONTROLLED_RELEASE_CELL_TIMEOUT_MS = 300_000;
export const ACP_RELEASE_CELL_TIMEOUT_MS = 1_800_000;
const RELEASE_CELL_TERMINATION_GRACE_MS = 5_000;
const SAFE_RELEASE_FAILURE_CODE = /^(?:acp_[a-z0-9_]+(?::[a-z0-9_]+)*|codex_[a-z0-9_]+(?::[a-z0-9_]+)*|journey_release_[a-z0-9_]{2,128})$/u;

type RunAndAttestReleaseCellsInput = Readonly<{
  matrix: JourneyReleaseMatrix;
  matrixFile: string;
  evidenceRoot: string;
  runnerExecutable: string;
  runnerSha256: string;
  runnerEnvironment?: Readonly<Record<string, string>>;
  issuerContext: RunnerOwnedEvidenceContext;
  /** Production release seal, re-evaluated around every independent cell. */
  verifyReleaseInputs: () => Promise<void>;
}>;

type DirectoryIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

type EvidenceTreeState = Readonly<{
  root: string;
  rootIdentity: DirectoryIdentity;
  cellsRoot: string;
  cellsRootIdentity: DirectoryIdentity;
  cellRootIdentities: Map<string, DirectoryIdentity>;
}>;

export function releaseCellRunnerTimeoutMs(bundleCellId: string): number {
  return bundleCellId === "cell_opencode-acp-task"
      || bundleCellId === "cell_codex-acp-task"
      || bundleCellId === "cell_acp-meta"
    ? ACP_RELEASE_CELL_TIMEOUT_MS
    : CONTROLLED_RELEASE_CELL_TIMEOUT_MS;
}

export async function runAndAttestReleaseCells(
  input: RunAndAttestReleaseCellsInput,
): Promise<readonly TrustedJourneyAttestation[]> {
  validateRunAndAttestReleaseCellsInput(input);
  await verifyRunner(input.runnerExecutable, input.runnerSha256);
  validateCellRootNames(input.matrix);
  await input.verifyReleaseInputs();
  const evidenceTree = await initializeEvidenceTree(input.evidenceRoot);
  const attestations: TrustedJourneyAttestation[] = [];
  const observedIds = new Set<string>();
  const observedAcpQualificationDigests = new Set<string>();
  const observedAcpProductionReceiptDigests = new Set<string>();
  const completedCellIds: string[] = [];
  for (const cell of input.matrix.cells) {
    await verifyReleaseBoundary(input.verifyReleaseInputs, evidenceTree, completedCellIds);
    const output = path.join(evidenceTree.cellsRoot, cell.bundleCellId);
    await mkdir(output, { recursive: false, mode: 0o700 });
    evidenceTree.cellRootIdentities.set(
      cell.bundleCellId,
      await observePrivateDirectory(output, "journey_release_evidence_cell_root_invalid"),
    );
    const runnerResult = await spawnCellRunner(
      input.runnerExecutable,
      input.matrix,
      input.matrixFile,
      cell,
      output,
      input.runnerEnvironment,
    );
    const observedCellIds = [...completedCellIds, cell.bundleCellId];
    await verifyReleaseBoundary(input.verifyReleaseInputs, evidenceTree, observedCellIds);
    if (runnerResult.exitCode === 2) {
      throw new ReleaseCellBlockedError([
        `${cell.bundleCellId}/${cell.scenarioId}`,
        runnerResult.failureCode,
      ].filter(Boolean).join(":"));
    }
    if (runnerResult.exitCode !== 0) {
      throw new Error([
        "journey_release_cell_runner_failed",
        cell.bundleCellId,
        runnerResult.exitCode,
        runnerResult.failureCode,
      ].filter((value) => value !== undefined).join(":"));
    }
    attestations.push(...await attestCell(
      input.matrix,
      cell,
      output,
      input.issuerContext,
      observedIds,
      observedAcpQualificationDigests,
      observedAcpProductionReceiptDigests,
    ));
    completedCellIds.push(cell.bundleCellId);
  }
  await verifyReleaseBoundary(input.verifyReleaseInputs, evidenceTree, completedCellIds);
  return Object.freeze(attestations);
}

function validateRunAndAttestReleaseCellsInput(input: RunAndAttestReleaseCellsInput): void {
  const required = [
    "matrix", "matrixFile", "evidenceRoot", "runnerExecutable", "runnerSha256", "issuerContext",
    "verifyReleaseInputs",
  ] as const;
  const allowed = new Set<string>([...required, "runnerEnvironment"]);
  if (!input || typeof input !== "object" || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error("journey_release_cell_runner_input_invalid");
  }
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !keys.includes(key))
    || keys.some((key) => typeof key === "string" && !("value" in descriptors[key]!))) {
    throw new Error("journey_release_cell_runner_input_invalid");
  }
  if (!input.matrix || typeof input.matrix !== "object" || !Array.isArray(input.matrix.cells)
    || typeof input.matrixFile !== "string"
    || typeof input.evidenceRoot !== "string"
    || typeof input.runnerExecutable !== "string"
    || typeof input.runnerSha256 !== "string"
    || !input.issuerContext || typeof input.issuerContext !== "object"
    || typeof input.verifyReleaseInputs !== "function"
    || (input.runnerEnvironment !== undefined
      && (!isPlainRecord(input.runnerEnvironment)
        || Object.values(input.runnerEnvironment).some((value) => typeof value !== "string")))) {
    throw new Error("journey_release_cell_runner_input_invalid");
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateCellRootNames(matrix: JourneyReleaseMatrix): void {
  const names = matrix.cells.map(({ bundleCellId }) => bundleCellId);
  if (names.some((name) => !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(name))
    || new Set(names).size !== names.length) {
    throw new Error("journey_release_evidence_cell_root_name_invalid");
  }
}

async function initializeEvidenceTree(root: string): Promise<EvidenceTreeState> {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    throw new Error("journey_release_evidence_root_invalid");
  }
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch {
    throw new Error("journey_release_evidence_root_invalid");
  }
  if (canonical !== root) throw new Error("journey_release_evidence_root_invalid");
  const rootIdentity = await observePrivateDirectory(root, "journey_release_evidence_root_invalid");
  await assertExactPrivateChildDirectories(
    root,
    rootIdentity,
    [],
    "journey_release_evidence_root_invalid",
    "journey_release_evidence_root_invalid",
  );
  const cellsRoot = path.join(root, "cells");
  try {
    await mkdir(cellsRoot, { recursive: false, mode: 0o700 });
  } catch {
    throw new Error("journey_release_evidence_root_contents_changed");
  }
  const state: EvidenceTreeState = Object.freeze({
    root,
    rootIdentity,
    cellsRoot,
    cellsRootIdentity: await observePrivateDirectory(
      cellsRoot,
      "journey_release_evidence_cells_root_invalid",
    ),
    cellRootIdentities: new Map<string, DirectoryIdentity>(),
  });
  await assertEvidenceTree(state, []);
  return state;
}

async function verifyReleaseBoundary(
  verifyReleaseInputs: () => Promise<void>,
  state: EvidenceTreeState,
  expectedCellIds: readonly string[],
): Promise<void> {
  await verifyReleaseInputs();
  await assertEvidenceTree(state, expectedCellIds);
}

async function assertEvidenceTree(state: EvidenceTreeState, expectedCellIds: readonly string[]): Promise<void> {
  await assertStablePrivateDirectory(
    state.root,
    state.rootIdentity,
    "journey_release_evidence_root_identity_changed",
  );
  let canonical: string;
  try {
    canonical = await realpath(state.root);
  } catch {
    throw new Error("journey_release_evidence_root_identity_changed");
  }
  if (canonical !== state.root) throw new Error("journey_release_evidence_root_identity_changed");
  await assertExactPrivateChildDirectories(
    state.root,
    state.rootIdentity,
    ["cells"],
    "journey_release_evidence_root_contents_changed",
    "journey_release_evidence_root_identity_changed",
  );
  await assertStablePrivateDirectory(
    state.cellsRoot,
    state.cellsRootIdentity,
    "journey_release_evidence_cells_root_identity_changed",
  );
  await assertExactPrivateChildDirectories(
    state.cellsRoot,
    state.cellsRootIdentity,
    expectedCellIds,
    "journey_release_evidence_root_contents_changed",
    "journey_release_evidence_cells_root_identity_changed",
  );
  for (const cellId of expectedCellIds) {
    const identity = state.cellRootIdentities.get(cellId);
    if (!identity) throw new Error("journey_release_evidence_cell_root_identity_missing");
    await assertStablePrivateDirectory(
      path.join(state.cellsRoot, cellId),
      identity,
      "journey_release_evidence_cell_root_identity_changed",
    );
  }
}

async function observePrivateDirectory(directory: string, errorCode: string): Promise<DirectoryIdentity> {
  let status;
  try {
    status = await lstat(directory, { bigint: true });
  } catch {
    throw new Error(errorCode);
  }
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (uid === undefined || !status.isDirectory() || status.isSymbolicLink()
    || status.uid !== uid || (status.mode & 0o7777n) !== 0o700n) {
    throw new Error(errorCode);
  }
  return Object.freeze({ dev: status.dev, ino: status.ino });
}

async function assertStablePrivateDirectory(
  directory: string,
  expected: DirectoryIdentity,
  errorCode: string,
): Promise<void> {
  const observed = await observePrivateDirectory(directory, errorCode);
  if (observed.dev !== expected.dev || observed.ino !== expected.ino) throw new Error(errorCode);
}

async function assertExactPrivateChildDirectories(
  directory: string,
  identity: DirectoryIdentity,
  expectedNames: readonly string[],
  contentsErrorCode = "journey_release_evidence_root_contents_changed",
  identityErrorCode = "journey_release_evidence_root_identity_changed",
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error(contentsErrorCode);
  }
  const observedNames = entries.map(({ name }) => name).sort();
  const exactNames = [...expectedNames].sort();
  if (!isDeepStrictEqual(observedNames, exactNames)
    || entries.some((entry) => entry.isSymbolicLink() || !entry.isDirectory())) {
    throw new Error(contentsErrorCode);
  }
  await assertStablePrivateDirectory(
    directory,
    identity,
    identityErrorCode,
  );
}

async function attestCell(
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
  output: string,
  context: RunnerOwnedEvidenceContext,
  crossCellObservedIds: Set<string>,
  crossCellAcpQualificationDigests: Set<string>,
  crossCellAcpProductionReceiptDigests: Set<string>,
): Promise<readonly TrustedJourneyAttestation[]> {
  const candidateFile = path.join(output, "candidate.json");
  await requirePrivateRegularFile(candidateFile);
  const candidateBytes = await readFile(candidateFile);
  const candidate = JSON.parse(candidateBytes.toString("utf8")) as ReleaseCellCandidate;
  assertEvidenceSafe(candidate);
  rejectAuthorityFields(candidate);
  validateCandidate(candidate, matrix, cell);
  const observedLineage = validateObservedLineage(candidate, cell);
  if (observedLineage) {
    for (const id of observedLineageIds(observedLineage)) {
      if (crossCellObservedIds.has(id)) throw new Error("journey_release_observed_lineage_cross_cell_reused");
      crossCellObservedIds.add(id);
    }
  }
  const manifestDigest = sha256(candidateBytes);
  const observedIssuers = new Set<ReleaseIssuer>();
  const referencedFiles = new Set<string>([candidateFile]);
  const attestations: TrustedJourneyAttestation[] = [];
  const ledgers = new Map<ReleaseIssuer, Readonly<Record<string, unknown>>>();
  for (const stream of candidate.streams) {
    if (observedIssuers.has(stream.issuer)) throw new Error("journey_release_candidate_stream_duplicate");
    observedIssuers.add(stream.issuer);
    const requirement = cell.streamRequirements.find(({ issuer }) => issuer === stream.issuer);
    if (!requirement) throw new Error("journey_release_candidate_stream_not_declared");
    if (observedLineage && stream.observedLineageDigest !== observedLineage.canonicalDigest) {
      throw new Error("journey_release_candidate_stream_lineage_digest_mismatch");
    }
    const ledgerFile = safeRelativeFile(output, stream.ledgerFile);
    referencedFiles.add(ledgerFile);
    await requirePrivateRegularFile(ledgerFile);
    const ledgerBytes = await readFile(ledgerFile);
    const ledger = JSON.parse(ledgerBytes.toString("utf8")) as Record<string, unknown>;
    assertEvidenceSafe(ledger);
    ledgers.set(stream.issuer, ledger);
    if (!isAcpReleaseAttestorIssuer(stream.issuer)) {
      validateCommonLedger(ledger, matrix, cell, requirement.checkpoints, observedLineage?.canonicalDigest);
    }
    if (observedLineage) validateReferencedLineageIds(ledger, observedLineage);
    if (isAcpReleaseAttestorIssuer(stream.issuer)) {
      const document = validateAcpReleaseAttestationDocument(ledger, {
        releaseRunId: matrix.releaseRunId,
        nonce: matrix.nonce,
        bundleCellId: cell.bundleCellId,
        scenarioId: cell.scenarioId,
        runtimeInstanceId: cell.lineage.runtimeInstanceId,
        observedLineageDigest: observedLineage.canonicalDigest,
        issuer: stream.issuer,
        expectedHostGenerations: stream.issuer === "acp_meta_attestor" ? [1] : [1, 2],
      });
      const observations = document.generations.flatMap(({ productionObservations }) => productionObservations);
      const cellQualificationDigests = new Set(observations.map(({ qualificationDigest }) => qualificationDigest));
      const cellProductionReceiptDigests = new Set(observations.map(({ productionReceiptDigest }) => productionReceiptDigest));
      if ([...cellQualificationDigests].some((digest) => crossCellAcpQualificationDigests.has(digest))
        || [...cellProductionReceiptDigests].some((digest) => crossCellAcpProductionReceiptDigests.has(digest))) {
          throw new Error("journey_release_acp_cross_cell_qualification_reused");
      }
      for (const digest of cellQualificationDigests) crossCellAcpQualificationDigests.add(digest);
      for (const digest of cellProductionReceiptDigests) crossCellAcpProductionReceiptDigests.add(digest);
    }
    if (stream.outcome === "BLOCKED_CAPABILITY") {
      throw new ReleaseCellBlockedError(`${cell.bundleCellId}/${stream.issuer}`);
    }
    attestations.push(issuerFor(context, stream.issuer).issue({
      journeyId: stream.journeyId,
      bundleCellId: cell.bundleCellId,
      scenarioId: cell.scenarioId,
      outcome: stream.outcome,
      checkpoints: stream.checkpoints,
      manifestDigest,
      ledgerChecksum: sha256(ledgerBytes),
      observedLineageDigest: observedLineage.canonicalDigest,
      actionTraces: stream.actionTraces,
      actionCorrelations: stream.actionCorrelations,
    }));
  }
  const expectedIssuers = new Set(cell.streamRequirements.map(({ issuer }) => issuer));
  if (observedIssuers.size !== expectedIssuers.size
    || [...expectedIssuers].some((issuer) => !observedIssuers.has(issuer as ReleaseIssuer))) {
    throw new Error("journey_release_candidate_required_stream_missing");
  }
  validateAcpCompanionStreams(cell, candidate.streams, ledgers);
  await assertOnlyReferencedPrivateFiles(output, referencedFiles);
  return attestations;
}

function validateAcpCompanionStreams(
  cell: JourneyReleaseCellDeclaration,
  streams: readonly ReleaseStreamCandidate[],
  ledgers: ReadonlyMap<ReleaseIssuer, Readonly<Record<string, unknown>>>,
): void {
  const provider = streams.find(({ issuer }) => isAcpReleaseAttestorIssuer(issuer));
  if (!provider) return;
  const providerRequirement = cell.streamRequirements.find(({ issuer }) => issuer === provider.issuer);
  const runtime = streams.find(({ issuer }) => issuer === "runtime_host");
  const runtimeRequirement = cell.streamRequirements.find(({ issuer }) => issuer === "runtime_host");
  const ui = streams.filter(({ issuer }) => issuer === "browser_ui_driver" || issuer === "electron_ui_driver");
  const uiRequirements = cell.streamRequirements.filter(({ issuer }) => (
    issuer === "browser_ui_driver" || issuer === "electron_ui_driver"
  ));
  if (!providerRequirement || provider.outcome !== "PASS"
    || !runtime || runtime.outcome !== "PASS" || !runtimeRequirement
    || ui.length === 0 || ui.length !== uiRequirements.length
    || ui.some((stream) => stream.outcome !== "PASS")) {
    throw new Error("journey_release_acp_companion_stream_missing");
  }
  const providerCheckpoints = new Set(providerRequirement.checkpoints);
  const runtimeCheckpoints = new Set(runtimeRequirement.checkpoints);
  const uiCheckpoints = new Set(uiRequirements.flatMap(({ checkpoints }) => checkpoints));
  if (providerCheckpoints.size !== runtimeCheckpoints.size
    || [...providerCheckpoints].some((checkpoint) => !runtimeCheckpoints.has(checkpoint))
    || [...providerCheckpoints].some((checkpoint) => !uiCheckpoints.has(checkpoint))) {
    throw new Error("journey_release_acp_companion_checkpoint_coverage_invalid");
  }
  const runtimeLedger = ledgers.get("runtime_host");
  if (!runtimeLedger || !Array.isArray(runtimeLedger.hostCommands)) {
    throw new Error("journey_release_acp_companion_runtime_ledger_invalid");
  }
  const correlatedCommandIds = new Set(ui.flatMap((stream) => (
    stream.actionCorrelations ?? []
  )).map(({ commandId }) => commandId));
  const hostCommandIds = runtimeLedger.hostCommands.map((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>).commandId
      : undefined
  ));
  if (correlatedCommandIds.size === 0
    || hostCommandIds.some((commandId) => typeof commandId !== "string")
    || correlatedCommandIds.size !== hostCommandIds.length
    || hostCommandIds.some((commandId) => !correlatedCommandIds.has(commandId as string))) {
    throw new Error("journey_release_acp_companion_command_correlation_invalid");
  }
}

async function verifyRunner(executable: string, expectedDigest: string): Promise<void> {
  if (!path.isAbsolute(executable)) throw new Error("journey_release_cell_runner_path_invalid");
  let status;
  try {
    status = await lstat(executable);
  } catch {
    throw new Error("journey_release_cell_runner_unavailable");
  }
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("journey_release_cell_runner_file_invalid");
  const expected = expectedDigest.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("journey_release_cell_runner_digest_invalid");
  const actual = createHash("sha256").update(await readFile(executable)).digest("hex");
  if (actual !== expected) throw new Error("journey_release_cell_runner_digest_mismatch");
}

export function spawnCellRunner(
  executable: string,
  matrix: JourneyReleaseMatrix,
  matrixFile: string,
  cell: JourneyReleaseCellDeclaration,
  output: string,
  runnerEnvironment: Readonly<Record<string, string>> | undefined,
  termination: Readonly<{ timeoutMs?: number; terminationGraceMs?: number }> = {},
): Promise<Readonly<{ exitCode: number; failureCode?: string }>> {
  const timeoutMs = termination.timeoutMs ?? releaseCellRunnerTimeoutMs(cell.bundleCellId);
  const terminationGraceMs = termination.terminationGraceMs ?? RELEASE_CELL_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    return Promise.resolve(Object.freeze({ exitCode: 1, failureCode: "journey_release_cell_runner_timeout_invalid" }));
  }
  return new Promise((resolve) => {
    const child = spawn(executable, [
      "--matrix", matrixFile,
      "--cell", cell.bundleCellId,
      "--scenario", cell.scenarioId,
      "--output", output,
    ], {
      cwd: path.resolve("."),
      env: {
        ...releaseCellEnvironment(cell, runnerEnvironment),
        AGENT_WORKSPACE_RELEASE_RUN_ID: matrix.releaseRunId,
        AGENT_WORKSPACE_RELEASE_NONCE: matrix.nonce,
        AGENT_WORKSPACE_RELEASE_CELL_ID: cell.bundleCellId,
        AGENT_WORKSPACE_RELEASE_SCENARIO_ID: cell.scenarioId,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"] as const,
      detached: process.platform !== "win32",
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      try { child.kill("SIGKILL"); } catch { /* spawn boundary already failed */ }
      resolve(Object.freeze({ exitCode: 1, failureCode: "journey_release_cell_runner_stdio_missing" }));
      return;
    }
    let outputBytes = 0;
    let stderrBuffer = "";
    let failureCode: string | undefined;
    let settled = false;
    let terminationRequested = false;
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const ownedProcessTrees = new Set<number>();
    const count = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1024 * 1024) {
        requestTermination("journey_release_cell_runner_output_limit");
      }
    };
    stdout.on("data", count);
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      count(chunk);
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-8_192);
      const lines = stderrBuffer.split(/\r?\n/u);
      stderrBuffer = lines.pop() ?? "";
      if (!terminationRequested) {
        for (const line of lines) failureCode = structuredReleaseFailureCode(line) ?? failureCode;
      }
    });
    const timeout = setTimeout(
      () => requestTermination("journey_release_cell_runner_timeout"),
      timeoutMs,
    );
    child.on("message", (message) => {
      const observed = processTreeMessage(message);
      if (!observed) return;
      if (observed.state === "started") ownedProcessTrees.add(observed.pid);
      else ownedProcessTrees.delete(observed.pid);
    });
    child.once("error", () => {
      void hardStopOwnedProcessTrees(child, ownedProcessTrees).finally(() => finish({
        exitCode: 1,
        failureCode: "journey_release_cell_runner_spawn_failed",
      }));
    });
    child.once("exit", (code, signal) => {
      if (!terminationRequested) failureCode = structuredReleaseFailureCode(stderrBuffer) ?? failureCode;
      void hardStopOwnedProcessTrees(child, ownedProcessTrees).finally(() => finish({
        exitCode: signal ? 1 : (code ?? 1),
        ...(failureCode ? { failureCode } : {}),
      }));
    });

    function requestTermination(code: string): void {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      failureCode = code;
      signalRunnerForGracefulShutdown(child);
      hardStop = setTimeout(() => {
        void hardStopOwnedProcessTrees(child, ownedProcessTrees).finally(() => finish({ exitCode: 1, failureCode: code }));
      }, terminationGraceMs);
    }

    function finish(result: Readonly<{ exitCode: number; failureCode?: string }>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (hardStop) clearTimeout(hardStop);
      resolve(Object.freeze(result));
    }
  });
}

function processTreeMessage(message: unknown): Readonly<{ state: "started" | "stopped"; pid: number }> | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const value = message as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "pid,state,type"
    || value.type !== "release_cell_process_tree"
    || (value.state !== "started" && value.state !== "stopped")
    || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1) return undefined;
  return Object.freeze({ state: value.state, pid: value.pid as number });
}

function signalRunnerForGracefulShutdown(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.connected) {
    try { child.send?.(Object.freeze({ type: "release_cell_shutdown" })); } catch { /* hard stop follows */ }
    return;
  }
  try { child.kill("SIGTERM"); } catch { /* hard stop follows */ }
}

async function hardStopOwnedProcessTrees(child: ChildProcess, owned: ReadonlySet<number>): Promise<void> {
  await Promise.all([
    ...[...owned].reverse().map((pid) => hardKillProcessTree(pid)),
    ...(child.pid ? [hardKillProcessTree(child.pid)] : []),
  ]);
}

async function hardKillProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await taskkillBounded(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function taskkillBounded(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(executable, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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

function structuredReleaseFailureCode(line: string): string | undefined {
  if (!line || line.length > 4_096) return undefined;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.outcome === "FAIL"
    && Object.keys(record).length === 2
    && typeof record.code === "string") return extract(record.code);
  if (record.outcome === "BLOCKED_CAPABILITY"
    && Object.keys(record).length === 2
    && typeof record.reason === "string") return extract(record.reason);
  return undefined;

  function extract(source: string): string | undefined {
    return source.length <= 192 && SAFE_RELEASE_FAILURE_CODE.test(source) ? source : undefined;
  }
}

/** Parent-to-cell boundary: cells never inherit ambient credentials or Provider-private paths. */
export function releaseCellEnvironment(
  cell: Pick<JourneyReleaseCellDeclaration, "bundleCellId" | "scenarioId">,
  additions: Readonly<Record<string, string>> | undefined = undefined,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const) copy(key);
  for (const [key, value] of Object.entries(additions ?? {})) {
    if (key !== "AGENT_WORKSPACE_RELEASE_CELL_RUNNER_SHA256"
      && key !== "AGENT_WORKSPACE_RELEASE_CELL_WORKER_SHA256") {
      throw new Error("journey_release_cell_runner_environment_addition_forbidden");
    }
    environment[key] = value;
  }
  if (cell.bundleCellId.startsWith("cell_browser-controlled-")
    || cell.bundleCellId.startsWith("cell_electron-controlled-")
    || cell.bundleCellId === "cell_cross-surface-continuity") {
    copy("AGENT_WORKSPACE_RELEASE_LAUNCH_MANIFEST");
  }
  if (cell.bundleCellId in ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS) {
    copy(ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS[
      cell.bundleCellId as keyof typeof ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS
    ]);
  }
  return environment;

  function copy(key: string): void {
    if (source[key] !== undefined) environment[key] = source[key];
  }
}

function validateCandidate(
  candidate: ReleaseCellCandidate,
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
): void {
  const allowed = [
    "schemaVersion", "releaseRunId", "nonce", "bundleCellId", "scenarioId", "lineage",
    "observedLineage", "observedLineageDigest", "streams",
  ];
  if (!candidate || typeof candidate !== "object"
    || Object.keys(candidate).some((key) => !allowed.includes(key))
    || candidate.schemaVersion !== 1
    || candidate.releaseRunId !== matrix.releaseRunId
    || candidate.nonce !== matrix.nonce
    || candidate.bundleCellId !== cell.bundleCellId
    || candidate.scenarioId !== cell.scenarioId
    || !isDeepStrictEqual(candidate.lineage, cell.lineage)
    || !Array.isArray(candidate.streams)) {
    throw new Error("journey_release_candidate_invalid");
  }
  for (const stream of candidate.streams) {
    const streamKeys = [
      "issuer", "journeyId", "outcome", "checkpoints", "ledgerFile", "observedLineageDigest",
      "actionTraces", "actionCorrelations",
    ];
    if (!stream || typeof stream !== "object"
      || Object.keys(stream).some((key) => !streamKeys.includes(key))
      || !/^journey_[A-Za-z0-9-]+$/.test(stream.journeyId)
      || !["PASS", "FAIL", "BLOCKED_CAPABILITY", "NOT_EXERCISED", "NOT_APPLICABLE"].includes(stream.outcome)
      || !Array.isArray(stream.checkpoints)
      || typeof stream.ledgerFile !== "string") {
      throw new Error("journey_release_candidate_stream_invalid");
    }
  }
}

function validateObservedLineage(
  candidate: ReleaseCellCandidate,
  cell: JourneyReleaseCellDeclaration,
): ObservedLineage {
  if (!candidate.observedLineage || !candidate.observedLineageDigest) {
    throw new Error("journey_release_candidate_observed_lineage_missing");
  }
  const value = candidate.observedLineage;
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
  if (Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
    || value.schemaVersion !== 1
    || value.runtimeInstanceId !== cell.lineage.runtimeInstanceId
    || value.canonicalDigest !== candidate.observedLineageDigest
    || !/^sha256:[a-f0-9]{64}$/u.test(value.canonicalDigest)) {
    throw new Error("journey_release_candidate_observed_lineage_invalid");
  }
  for (const field of arrayFields) {
    const entries = value[field];
    const prefix = prefixes[field];
    if (!Array.isArray(entries)
      || entries.some((entry) => typeof entry !== "string" || entry.length > 128
        || !new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(entry)
        || /(?:^|[-_])fallback(?:[-_]|$)/u.test(entry))) {
      throw new Error("journey_release_candidate_observed_lineage_invalid");
    }
  }
  if (cell.bundleCellId === "cell_acp-meta") {
    if (value.metaSessionIds.length === 0 || value.metaTurnIds.length === 0
      || value.taskIds.length > 0 || value.runIds.length > 0 || value.cardSessionSlotIds.length > 0
      || value.logicalSessionIds.length > 0 || value.bindingIds.length > 0
      || value.inputSubmissionIds.length > 0 || value.sessionTurnIds.length > 0) {
      throw new Error("journey_release_candidate_acp_meta_lineage_invalid");
    }
  } else if (cell.bundleCellId === "cell_opencode-acp-task" || cell.bundleCellId === "cell_codex-acp-task") {
    if (value.taskIds.length === 0 || value.runIds.length === 0 || value.cardSessionSlotIds.length === 0
      || value.logicalSessionIds.length === 0 || value.bindingIds.length === 0 || value.messageIds.length === 0
      || value.inputSubmissionIds.length === 0 || value.sessionTurnIds.length === 0
      || value.metaSessionIds.length > 0 || value.metaTurnIds.length > 0) {
      throw new Error("journey_release_candidate_acp_task_lineage_invalid");
    }
  }
  const digestInput = Object.freeze(Object.fromEntries(
    keys.filter((key) => key !== "canonicalDigest").map((key) => [key, value[key as keyof ObservedLineage]]),
  ));
  if (sessionIdObservedLineageDigest(digestInput as never) !== value.canonicalDigest) {
    throw new Error("journey_release_candidate_observed_lineage_digest_mismatch");
  }
  const ids = observedLineageIds(value);
  if (new Set(ids).size !== ids.length) throw new Error("journey_release_candidate_observed_lineage_duplicate");
  return value;
}

function observedLineageIds(value: ObservedLineage): readonly string[] {
  return Object.freeze([
    value.runtimeInstanceId,
    ...value.templateDraftIds,
    ...value.taskSetupDraftIds,
    ...value.taskIds,
    ...value.runIds,
    ...value.metaSessionIds,
    ...value.metaTurnIds,
    ...value.cardSessionSlotIds,
    ...value.logicalSessionIds,
    ...value.bindingIds,
    ...value.messageIds,
    ...value.messageForwardIds,
    ...value.humanInterventionIds,
    ...value.inputSubmissionIds,
    ...value.sessionTurnIds,
    ...value.sessionControlAuditIds,
  ]);
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
    if (!candidate || typeof candidate !== "object") {
      if (typeof candidate === "string" && field && byField[field] && !byField[field].has(candidate)) {
        throw new Error("journey_release_candidate_observed_lineage_reference_unknown");
      }
      return;
    }
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) visit(entry, key);
  }
}

function validateCommonLedger(
  ledger: Readonly<Record<string, unknown>>,
  matrix: JourneyReleaseMatrix,
  cell: JourneyReleaseCellDeclaration,
  expectedCheckpoints: readonly FullJourneyCheckpoint[],
  observedLineageDigest?: string,
): void {
  if (ledger.schemaVersion !== 1
    || ledger.releaseRunId !== matrix.releaseRunId
    || ledger.nonce !== matrix.nonce
    || ledger.bundleCellId !== cell.bundleCellId
    || ledger.scenarioId !== cell.scenarioId
    || ledger.runtimeInstanceId !== cell.lineage.runtimeInstanceId
    || !Array.isArray(ledger.checkpointFacts)
    || (observedLineageDigest !== undefined && ledger.observedLineageDigest !== observedLineageDigest)) {
    throw new Error("journey_release_stream_ledger_invalid");
  }
  const observed = new Set<string>();
  for (const fact of ledger.checkpointFacts) {
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) throw new Error("journey_release_stream_fact_invalid");
    const checkpoint = (fact as Record<string, unknown>).checkpoint;
    if (typeof checkpoint !== "string" || !expectedCheckpoints.includes(checkpoint as FullJourneyCheckpoint)) {
      throw new Error("journey_release_stream_fact_checkpoint_invalid");
    }
    observed.add(checkpoint);
  }
  if (expectedCheckpoints.some((checkpoint) => !observed.has(checkpoint))) {
    throw new Error("journey_release_stream_fact_checkpoint_missing");
  }
}

function rejectAuthorityFields(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(rejectAuthorityFields);
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (["evidenceClass", "surface", "status"].includes(key)) {
      throw new Error("journey_release_candidate_authority_field_forbidden");
    }
    rejectAuthorityFields(entry);
  }
}

function safeRelativeFile(root: string, relative: string): string {
  if (!/^[a-z0-9][a-z0-9._/-]*\.json$/.test(relative) || relative.split("/").includes("..")) {
    throw new Error("journey_release_candidate_ledger_path_invalid");
  }
  const absolute = path.resolve(root, relative);
  if (path.dirname(absolute) !== root && !path.dirname(absolute).startsWith(`${root}${path.sep}`)) {
    throw new Error("journey_release_candidate_ledger_path_invalid");
  }
  return absolute;
}

async function requirePrivateRegularFile(file: string): Promise<void> {
  const status = await lstat(file);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o600) {
    throw new Error("journey_release_candidate_file_permissions_invalid");
  }
}

async function assertOnlyReferencedPrivateFiles(root: string, referenced: ReadonlySet<string>): Promise<void> {
  const observed = new Set<string>();
  await walk(root);
  if (observed.size !== referenced.size || [...referenced].some((file) => !observed.has(file))) {
    throw new Error("journey_release_candidate_unreferenced_file");
  }

  async function walk(directory: string): Promise<void> {
    const directoryStatus = await lstat(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink() || (directoryStatus.mode & 0o777) !== 0o700) {
      throw new Error("journey_release_candidate_directory_permissions_invalid");
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("journey_release_candidate_symlink_forbidden");
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        await requirePrivateRegularFile(absolute);
        observed.add(absolute);
      } else {
        throw new Error("journey_release_candidate_entry_invalid");
      }
    }
  }
}

function issuerFor(context: RunnerOwnedEvidenceContext, issuer: ReleaseIssuer): RunnerOwnedEvidenceIssuer {
  switch (issuer) {
    case "runtime_host": return context.runtimeHost;
    case "browser_ui_driver": return context.browser;
    case "electron_ui_driver": return context.electron;
    case "opencode_acp_task_attestor": return context.openCodeAcpTask;
    case "codex_acp_task_attestor": return context.codexAcpTask;
    case "acp_meta_attestor": return context.acpMeta;
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
