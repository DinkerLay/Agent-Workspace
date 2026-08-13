import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  createAcpProductionHostInputs,
  parseAcpProductionConfiguration,
} from "../../apps/runtime-host/src/acp-production-configuration.js";
import {
  ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS,
  validateAcpReleaseHostEnvironmentEnvelope,
  type AcpReleaseHostEnvironmentEnvelope,
} from "./support/acp-release-cell-launcher.js";
import type { AcpReleaseAttestorIssuer } from "./acp-release-attestation.js";

const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_AUTH_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SAFE_COMMAND = /^[A-Za-z0-9._+-]{1,255}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

const LANE_INPUTS = Object.freeze([
  Object.freeze({
    issuer: "opencode_acp_task_attestor" as const,
    environmentKey: ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_opencode-acp-task"],
  }),
  Object.freeze({
    issuer: "codex_acp_task_attestor" as const,
    environmentKey: ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_codex-acp-task"],
  }),
  Object.freeze({
    issuer: "acp_meta_attestor" as const,
    environmentKey: ACP_RELEASE_HOST_ENVIRONMENT_PATH_KEYS["cell_acp-meta"],
  }),
] as const);

export type AcpReleaseParentInputSealSafeObservation = Readonly<{
  schemaVersion: 1;
  kind: "acp_release_parent_input_seal";
  digest: string;
}>;

export type AcpReleaseParentInputSeal = Readonly<{
  safeObservation(): AcpReleaseParentInputSealSafeObservation;
  toJSON(): AcpReleaseParentInputSealSafeObservation;
}>;

export type AcpReleaseParentQualificationInput =
  | Readonly<{
      issuer: "opencode_acp_task_attestor" | "codex_acp_task_attestor";
      taskWorkspaceDirectory: string;
      taskModel: string;
      environment: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      issuer: "acp_meta_attestor";
      metaProfileOptionId: string;
      environment: Readonly<Record<string, string>>;
    }>;

type FileSnapshot = Readonly<{
  requestedPath: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}>;

type DirectorySnapshot = Readonly<{
  requestedPath: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

type LaneSnapshot = Readonly<{
  issuer: AcpReleaseAttestorIssuer;
  envelope: FileSnapshot;
  workspace: DirectorySnapshot;
  artifacts: readonly Readonly<{ kind: string; file: FileSnapshot }>[];
  auth: FileSnapshot;
  laneDigest: string;
}>;

type LaneObservation = Readonly<{
  snapshot: LaneSnapshot;
  envelope: AcpReleaseHostEnvironmentEnvelope;
}>;

type SealState = {
  readonly environmentFiles: Readonly<Record<string, string>>;
  readonly lanes: readonly LaneSnapshot[];
  readonly digest: string;
  readonly privateSalt: Buffer;
  qualificationClaimed: boolean;
  status: "fresh" | "consuming" | "consumed";
};

const STATE = new WeakMap<object, SealState>();
const LANE_STATE = new WeakMap<object, {
  readonly issuer: AcpReleaseAttestorIssuer;
  readonly envelopeFile: string;
  readonly privateSalt: Buffer;
  readonly snapshot: LaneSnapshot;
  status: "fresh" | "consuming" | "consumed";
}>();

export type AcpReleaseLaneInputSeal = Readonly<{
  hostEnvironment(): AcpReleaseHostEnvironmentEnvelope;
  toJSON(): AcpReleaseParentInputSealSafeObservation;
}>;

export class AcpReleaseParentPreflightBlockedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AcpReleaseParentPreflightBlockedError";
  }
}

/**
 * Read-only parent input inspection. This function never runs an artifact,
 * creates a Runtime root, builds, opens a database, or starts a Provider.
 */
export async function createAcpReleaseParentInputSeal(input: Readonly<{
  environment?: NodeJS.ProcessEnv;
}> = {}): Promise<AcpReleaseParentInputSeal> {
  const environmentFiles = exactEnvironmentFiles(input.environment ?? process.env);
  const privateSalt = randomBytes(32);
  const observations = await observeAllLaneObservations(environmentFiles, privateSalt);
  const lanes = snapshotsOf(observations);
  const digest = aggregateDigest(lanes, privateSalt);
  const observation = safeObservation(digest);
  const seal = Object.freeze({
    safeObservation: () => observation,
    toJSON: () => observation,
  });
  STATE.set(seal, {
    environmentFiles,
    lanes,
    digest,
    privateSalt,
    qualificationClaimed: false,
    status: "fresh",
  });
  return seal;
}

/** Host-private single-lane seal used again inside the cell launcher process. */
export async function createAcpReleaseLaneInputSeal(input: Readonly<{
  envelopeFile: string;
  issuer: AcpReleaseAttestorIssuer;
}>): Promise<AcpReleaseLaneInputSeal> {
  const envelopeFile = requireCanonicalAbsoluteSyntax(
    input.envelopeFile,
    "acp_release_parent_envelope_invalid",
  );
  const privateSalt = randomBytes(32);
  const observation = await observeLane(envelopeFile, input.issuer, privateSalt);
  const safe = safeObservation(privateDigest(privateSalt, {
    issuer: input.issuer,
    laneDigest: observation.snapshot.laneDigest,
  }));
  const seal = Object.freeze({
    hostEnvironment: () => observation.envelope,
    toJSON: () => safe,
  });
  LANE_STATE.set(seal, {
    issuer: input.issuer,
    envelopeFile,
    privateSalt,
    snapshot: observation.snapshot,
    status: "fresh",
  });
  return seal;
}

export async function consumeAcpReleaseLaneInputSealBeforeFirstEffect(
  seal: AcpReleaseLaneInputSeal,
): Promise<void> {
  const state = seal && typeof seal === "object" ? LANE_STATE.get(seal as object) : undefined;
  if (!state) throw blocked("acp_release_lane_input_seal_invalid");
  if (state.status !== "fresh") throw blocked("acp_release_lane_input_seal_already_consumed");
  state.status = "consuming";
  try {
    const current = await observeLane(state.envelopeFile, state.issuer, state.privateSalt);
    if (current.snapshot.laneDigest !== state.snapshot.laneDigest) {
      throw blocked("acp_release_parent_input_drift");
    }
    state.status = "consumed";
  } catch (error) {
    state.status = "consumed";
    throw error;
  }
}

/**
 * One-shot authority boundary. Full files/directories are re-opened and
 * re-hashed immediately before the caller's first qualification effect.
 */
export async function consumeAcpReleaseParentInputSealBeforeFirstEffect(
  seal: AcpReleaseParentInputSeal,
): Promise<AcpReleaseParentInputSealSafeObservation> {
  const state = requireSeal(seal);
  if (state.status !== "fresh") throw blocked("acp_release_parent_input_seal_already_consumed");
  state.status = "consuming";
  try {
    await assertSnapshotCurrent(state);
    state.status = "consumed";
    return safeObservation(state.digest);
  } catch (error) {
    state.status = "consumed";
    throw error;
  }
}

/**
 * Capability-bound private inputs for the qualification parent. Callers never
 * re-read ambient process.env and cannot select a different lane envelope.
 */
export async function claimAcpReleaseParentQualificationInputs(
  seal: AcpReleaseParentInputSeal,
): Promise<readonly AcpReleaseParentQualificationInput[]> {
  const state = requireSeal(seal);
  if (state.status !== "consumed") {
    throw blocked("acp_release_parent_input_seal_not_consumed");
  }
  if (state.qualificationClaimed) {
    throw blocked("acp_release_parent_qualification_inputs_already_claimed");
  }
  state.qualificationClaimed = true;
  const observations = await assertSnapshotCurrent(state);
  return Object.freeze(observations.map(({ envelope }) => envelope.issuer === "acp_meta_attestor"
    ? Object.freeze({
        issuer: envelope.issuer,
        metaProfileOptionId: envelope.metaProfileOptionId!,
        environment: envelope.hostEnvironment,
      })
    : Object.freeze({
        issuer: envelope.issuer,
        taskWorkspaceDirectory: envelope.workspaceDirectory,
        taskModel: envelope.taskModel!,
        environment: envelope.hostEnvironment,
      })));
}

/** Revalidation used after qualification and after every gate/build boundary. */
export async function verifyFrozenAcpReleaseParentInputSeal(
  seal: AcpReleaseParentInputSeal,
): Promise<void> {
  const state = requireSeal(seal);
  if (state.status === "consuming") throw blocked("acp_release_parent_input_seal_busy");
  await assertSnapshotCurrent(state);
}

async function assertSnapshotCurrent(state: SealState): Promise<readonly LaneObservation[]> {
  const observations = await observeAllLaneObservations(state.environmentFiles, state.privateSalt);
  const current = snapshotsOf(observations);
  if (aggregateDigest(current, state.privateSalt) !== state.digest || !sameLaneSnapshots(current, state.lanes)) {
    throw blocked("acp_release_parent_input_drift");
  }
  return observations;
}

async function observeAllLaneObservations(
  environmentFiles: Readonly<Record<string, string>>,
  privateSalt: Buffer,
): Promise<readonly LaneObservation[]> {
  const observations = await Promise.all(LANE_INPUTS.map(({ issuer, environmentKey }) => (
    observeLane(environmentFiles[environmentKey]!, issuer, privateSalt)
  )));
  const lanes = snapshotsOf(observations);
  const workspacePaths = lanes.map(({ workspace }) => workspace.canonicalPath);
  const workspaceIdentities = lanes.map(({ workspace }) => `${workspace.dev}:${workspace.ino}`);
  const envelopePaths = lanes.map(({ envelope }) => envelope.canonicalPath);
  if (new Set(workspacePaths).size !== workspacePaths.length
    || new Set(workspaceIdentities).size !== workspaceIdentities.length) {
    throw blocked("acp_release_parent_workspace_not_independent");
  }
  if (new Set(envelopePaths).size !== envelopePaths.length) {
    throw blocked("acp_release_parent_envelope_not_independent");
  }
  return Object.freeze(observations);
}

function snapshotsOf(observations: readonly LaneObservation[]): readonly LaneSnapshot[] {
  return Object.freeze(observations.map(({ snapshot }) => snapshot));
}

async function observeLane(
  envelopePath: string,
  issuer: AcpReleaseAttestorIssuer,
  privateSalt: Buffer,
): Promise<LaneObservation> {
  const envelopeRead = await readSecureFile(envelopePath, {
    kind: "envelope",
    maxBytes: MAX_ENVELOPE_BYTES,
    executable: false,
    collectBytes: true,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeRead.bytes.toString("utf8"));
  } catch {
    throw blocked("acp_release_parent_envelope_invalid");
  }
  let envelope: AcpReleaseHostEnvironmentEnvelope;
  try {
    envelope = validateAcpReleaseHostEnvironmentEnvelope(parsed, issuer);
  } catch {
    throw blocked("acp_release_parent_envelope_invalid");
  }
  const workspace = await observeEmptyPrivateWorkspace(envelope.workspaceDirectory);
  const configuration = parseAcpProductionConfiguration(
    envelope.hostEnvironment.AGENT_WORKSPACE_ACP_CONFIG!,
  );
  const hostInputs = createAcpProductionHostInputs(configuration, envelope.hostEnvironment);
  const artifacts: Array<Readonly<{ kind: string; file: FileSnapshot }>> = [];
  let authFile: string;
  if (issuer === "opencode_acp_task_attestor") {
    const selected = hostInputs.openCode();
    if (!selected || hostInputs.codex()) throw blocked("acp_release_parent_lane_mismatch");
    artifacts.push(Object.freeze({
      kind: "opencode",
      file: await resolveSecureCommand(selected.commandReference, selected.executableSearchPath, privateSalt),
    }));
    authFile = selected.authFile;
  } else if (issuer === "codex_acp_task_attestor") {
    const selected = hostInputs.codex();
    if (!selected || hostInputs.openCode()) throw blocked("acp_release_parent_lane_mismatch");
    artifacts.push(
      Object.freeze({
        kind: "codex_acp_wrapper",
        file: await resolveSecureCommand(selected.wrapperCommandReference, selected.executableSearchPath, privateSalt),
      }),
      Object.freeze({
        kind: "codex",
        file: await resolveSecureCommand(selected.codexCommandReference, selected.executableSearchPath, privateSalt),
      }),
      Object.freeze({
        kind: "node",
        file: await resolveSecureCommand(selected.nodeCommandReference, selected.executableSearchPath, privateSalt),
      }),
    );
    authFile = selected.authFile;
  } else {
    const option = configuration.metaProfiles[0];
    if (!option || option.metaProfileOptionId !== envelope.metaProfileOptionId) {
      throw blocked("acp_release_parent_lane_mismatch");
    }
    if (option.profile.providerFamily === "opencode") {
      const selected = hostInputs.openCode();
      if (!selected || hostInputs.codex()) throw blocked("acp_release_parent_lane_mismatch");
      artifacts.push(Object.freeze({
        kind: "meta_opencode",
        file: await resolveSecureCommand(selected.commandReference, selected.executableSearchPath, privateSalt),
      }));
      authFile = selected.authFile;
    } else {
      const selected = hostInputs.codex();
      if (!selected || hostInputs.openCode()) throw blocked("acp_release_parent_lane_mismatch");
      artifacts.push(
        Object.freeze({
          kind: "meta_codex_acp_wrapper",
          file: await resolveSecureCommand(selected.wrapperCommandReference, selected.executableSearchPath, privateSalt),
        }),
        Object.freeze({
          kind: "meta_codex",
          file: await resolveSecureCommand(selected.codexCommandReference, selected.executableSearchPath, privateSalt),
        }),
        Object.freeze({
          kind: "meta_node",
          file: await resolveSecureCommand(selected.nodeCommandReference, selected.executableSearchPath, privateSalt),
        }),
      );
      authFile = selected.authFile;
    }
  }
  const auth = (await readSecureFile(authFile, {
    kind: "auth",
    maxBytes: MAX_AUTH_BYTES,
    executable: false,
    collectBytes: false,
    readContent: false,
    privateFingerprintSalt: privateSalt,
  })).snapshot;
  const laneBody = Object.freeze({
    issuer,
    envelope: publicFingerprint(envelopeRead.snapshot),
    workspace: publicDirectoryFingerprint(workspace),
    artifacts: artifacts.map(({ kind, file }) => Object.freeze({ kind, file: publicFingerprint(file) })),
    auth: publicFingerprint(auth),
  });
  return Object.freeze({
    envelope,
    snapshot: Object.freeze({
      issuer,
      envelope: envelopeRead.snapshot,
      workspace,
      artifacts: Object.freeze(artifacts),
      auth,
      laneDigest: privateDigest(privateSalt, laneBody),
    }),
  });
}

async function resolveSecureCommand(
  reference: string,
  searchPath: string,
  privateSalt: Buffer,
): Promise<FileSnapshot> {
  const candidates = path.isAbsolute(reference)
    ? [requireCanonicalAbsoluteSyntax(reference, "acp_release_parent_command_invalid")]
    : resolveSearchCandidates(reference, searchPath);
  for (const candidate of candidates) {
    try {
      return (await readSecureFile(candidate, {
        kind: "artifact",
        maxBytes: MAX_ARTIFACT_BYTES,
        executable: true,
        collectBytes: false,
        privateFingerprintSalt: privateSalt,
      })).snapshot;
    } catch (error) {
      if (error instanceof AcpReleaseParentPreflightBlockedError
        && error.code === "acp_release_parent_file_missing") continue;
      throw error;
    }
  }
  throw blocked("acp_release_parent_command_not_found");
}

function resolveSearchCandidates(reference: string, searchPath: string): readonly string[] {
  if (!SAFE_COMMAND.test(reference) || reference.includes(path.sep)) {
    throw blocked("acp_release_parent_command_invalid");
  }
  if (typeof searchPath !== "string" || !searchPath || searchPath.includes("\0")) {
    throw blocked("acp_release_parent_search_path_invalid");
  }
  const directories = searchPath.split(path.delimiter);
  if (directories.length === 0 || directories.some((entry) => !path.isAbsolute(entry))) {
    throw blocked("acp_release_parent_search_path_invalid");
  }
  return Object.freeze(directories.map((entry) => path.join(
    requireCanonicalAbsoluteSyntax(entry, "acp_release_parent_search_path_invalid"),
    reference,
  )));
}

async function readSecureFile(
  value: string,
  policy: Readonly<{
    kind: "envelope" | "auth" | "artifact";
    maxBytes: number;
    executable: boolean;
    collectBytes: boolean;
    readContent?: boolean;
    privateFingerprintSalt?: Buffer;
  }>,
): Promise<Readonly<{ snapshot: FileSnapshot; bytes: Buffer }>> {
  const requestedPath = requireCanonicalAbsoluteSyntax(value, `acp_release_parent_${policy.kind}_invalid`);
  let before: Stats;
  try {
    before = await lstat(requestedPath);
  } catch (error) {
    if (isMissing(error)) throw blocked("acp_release_parent_file_missing");
    throw blocked(`acp_release_parent_${policy.kind}_invalid`);
  }
  assertSecureFileMetadata(before, policy);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(requestedPath);
  } catch {
    throw blocked(`acp_release_parent_${policy.kind}_invalid`);
  }
  if (canonicalPath !== requestedPath) throw blocked(`acp_release_parent_${policy.kind}_symlink_forbidden`);
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(requestedPath, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    assertSameFile(before, opened, `acp_release_parent_${policy.kind}_drift`);
    const { bytes, digest: contentDigest, byteLength } = policy.readContent === false
      ? { bytes: Buffer.alloc(0), digest: privateMetadataToken(policy.privateFingerprintSalt, opened), byteLength: opened.size }
      : await fingerprintOpenFile(
          handle,
          opened.size,
          policy.maxBytes,
          policy.collectBytes,
          policy.privateFingerprintSalt,
        );
    const afterRead = await handle.stat();
    assertSameFile(opened, afterRead, `acp_release_parent_${policy.kind}_drift`);
    if (byteLength !== opened.size || byteLength < 1 || byteLength > policy.maxBytes) {
      throw blocked(`acp_release_parent_${policy.kind}_invalid`);
    }
    const afterPath = await lstat(requestedPath);
    assertSameFile(afterRead, afterPath, `acp_release_parent_${policy.kind}_drift`);
    const snapshot = Object.freeze({
      requestedPath,
      canonicalPath,
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode,
      uid: opened.uid,
      nlink: opened.nlink,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      digest: contentDigest,
    });
    return Object.freeze({ snapshot, bytes });
  } catch (error) {
    if (error instanceof AcpReleaseParentPreflightBlockedError) throw error;
    throw blocked(`acp_release_parent_${policy.kind}_invalid`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertSecureFileMetadata(
  metadata: Stats,
  policy: Readonly<{ kind: "envelope" | "auth" | "artifact"; maxBytes: number; executable: boolean }>,
): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || metadata.nlink < 1 || metadata.size < 1 || metadata.size > policy.maxBytes) {
    throw blocked(`acp_release_parent_${policy.kind}_invalid`);
  }
  if (process.platform === "win32") return;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (policy.kind === "artifact") {
    if ((metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0
      || (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)) {
      throw blocked("acp_release_parent_artifact_untrusted");
    }
  } else if ((metadata.mode & 0o777) !== 0o600
    || metadata.nlink !== 1
    || (uid !== undefined && metadata.uid !== uid)) {
    throw blocked(`acp_release_parent_${policy.kind}_permissions_invalid`);
  }
}

async function observeEmptyPrivateWorkspace(value: string): Promise<DirectorySnapshot> {
  const requestedPath = requireCanonicalAbsoluteSyntax(value, "acp_release_parent_workspace_invalid");
  let before: Stats;
  try {
    before = await lstat(requestedPath);
  } catch {
    throw blocked("acp_release_parent_workspace_invalid");
  }
  const canonicalPath = await realpath(requestedPath).catch(() => "");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!before.isDirectory() || before.isSymbolicLink() || canonicalPath !== requestedPath
    || before.nlink < 1
    || (process.platform !== "win32" && (before.mode & 0o777) !== 0o700)
    || (uid !== undefined && before.uid !== uid)) {
    throw blocked("acp_release_parent_workspace_invalid");
  }
  if ((await readdir(requestedPath)).length !== 0) {
    throw blocked("acp_release_parent_workspace_not_empty");
  }
  const after = await lstat(requestedPath);
  assertSameDirectory(before, after, "acp_release_parent_workspace_drift");
  if ((await readdir(requestedPath)).length !== 0) {
    throw blocked("acp_release_parent_workspace_not_empty");
  }
  return Object.freeze({
    requestedPath,
    canonicalPath,
    dev: after.dev,
    ino: after.ino,
    mode: after.mode,
    uid: after.uid,
    nlink: after.nlink,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  });
}

function exactEnvironmentFiles(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const { environmentKey } of LANE_INPUTS) {
    const value = environment[environmentKey];
    if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
      throw blocked("acp_release_parent_envelope_missing");
    }
    result[environmentKey] = requireCanonicalAbsoluteSyntax(value, "acp_release_parent_envelope_invalid");
  }
  return Object.freeze(result);
}

function aggregateDigest(lanes: readonly LaneSnapshot[], privateSalt: Buffer): string {
  return privateDigest(
    privateSalt,
    Object.freeze(lanes.map(({ issuer, laneDigest }) => Object.freeze({ issuer, laneDigest }))),
  );
}

function sameLaneSnapshots(left: readonly LaneSnapshot[], right: readonly LaneSnapshot[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry.issuer === right[index]?.issuer
      && entry.laneDigest === right[index]?.laneDigest);
}

function publicFingerprint(file: FileSnapshot): unknown {
  return Object.freeze({
    dev: file.dev,
    ino: file.ino,
    mode: file.mode,
    uid: file.uid,
    nlink: file.nlink,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ctimeMs: file.ctimeMs,
    digest: file.digest,
  });
}

function publicDirectoryFingerprint(directory: DirectorySnapshot): unknown {
  return Object.freeze({
    dev: directory.dev,
    ino: directory.ino,
    mode: directory.mode,
    uid: directory.uid,
    nlink: directory.nlink,
    mtimeMs: directory.mtimeMs,
    ctimeMs: directory.ctimeMs,
  });
}

function assertSameFile(left: Stats, right: Stats, code: string): void {
  if (left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode
    || left.nlink !== right.nlink
    || left.uid !== right.uid || left.size !== right.size || left.mtimeMs !== right.mtimeMs
    || left.ctimeMs !== right.ctimeMs) throw blocked(code);
}

function assertSameDirectory(left: Stats, right: Stats, code: string): void {
  if (left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode
    || left.nlink !== right.nlink
    || left.uid !== right.uid || left.mtimeMs !== right.mtimeMs || left.ctimeMs !== right.ctimeMs) {
    throw blocked(code);
  }
}

function requireCanonicalAbsoluteSyntax(value: string, code: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw blocked(code);
  const normalized = path.normalize(value);
  if (normalized !== value) throw blocked(code);
  return value;
}

function requireSeal(seal: AcpReleaseParentInputSeal): SealState {
  const state = seal && typeof seal === "object" ? STATE.get(seal as object) : undefined;
  if (!state) throw blocked("acp_release_parent_input_seal_invalid");
  return state;
}

function safeObservation(digestValue: string): AcpReleaseParentInputSealSafeObservation {
  if (!SHA256.test(digestValue)) throw blocked("acp_release_parent_input_digest_invalid");
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "acp_release_parent_input_seal" as const,
    digest: digestValue,
  });
}

function privateDigest(privateSalt: Buffer, value: unknown): string {
  return `sha256:${createHmac("sha256", privateSalt).update(JSON.stringify(value)).digest("hex")}`;
}

function privateMetadataToken(privateSalt: Buffer | undefined, metadata: Stats): string {
  if (!privateSalt) throw blocked("acp_release_parent_private_fingerprint_missing");
  return privateDigest(privateSalt, {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  });
}

async function fingerprintOpenFile(
  handle: FileHandle,
  expectedBytes: number,
  maxBytes: number,
  collectBytes: boolean,
  privateFingerprintSalt?: Buffer,
): Promise<Readonly<{ bytes: Buffer; digest: string; byteLength: number }>> {
  const fingerprint = privateFingerprintSalt
    ? createHmac("sha256", privateFingerprintSalt)
    : createHash("sha256");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(buffer.byteLength, expectedBytes - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead < 1) break;
    const chunk = buffer.subarray(0, bytesRead);
    fingerprint.update(chunk);
    if (collectBytes) chunks.push(Buffer.from(chunk));
    position += bytesRead;
    if (position > maxBytes) throw blocked("acp_release_parent_file_too_large");
  }
  return Object.freeze({
    bytes: collectBytes ? Buffer.concat(chunks) : Buffer.alloc(0),
    digest: `sha256:${fingerprint.digest("hex")}`,
    byteLength: position,
  });
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function blocked(code: string): AcpReleaseParentPreflightBlockedError {
  return new AcpReleaseParentPreflightBlockedError(code);
}
