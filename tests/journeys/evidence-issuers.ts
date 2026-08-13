import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import {
  verifyJourneyEvidenceMatrix,
  type FullJourneyCheckpoint,
  type JourneyEvidenceCellDeclaration,
  type JourneyEvidenceCellResult,
  type JourneyEvidenceIssuer,
  type JourneyEvidenceLineage,
  type JourneyEvidenceMatrix,
  type JourneyEvidenceStream,
  type JourneyOutcome,
  type JourneyReleaseIdentity,
} from "../e2e/journey-evidence.js";
import {
  verifyActionCommandCorrelation,
  type ActionCommandCorrelation,
  type JourneyActionTrace,
} from "./locator-action-dsl.js";

export type JourneyStreamRequirement = JourneyEvidenceStream & Readonly<{
  checkpoints: readonly FullJourneyCheckpoint[];
}>;

export type JourneyReleaseCellDeclaration = Omit<JourneyEvidenceCellDeclaration, "streams"> & Readonly<{
  streamRequirements: readonly JourneyStreamRequirement[];
}>;

export type JourneyReleaseMatrix = JourneyReleaseIdentity & Readonly<{
  cells: readonly JourneyReleaseCellDeclaration[];
}>;

export type TrustedJourneyAttestationPayload = Readonly<{
  result: JourneyEvidenceCellResult;
  checkpoints: readonly FullJourneyCheckpoint[];
  manifestDigest: string;
  ledgerChecksum: string;
  observedLineageDigest: string;
  actionTraces: readonly JourneyActionTrace[];
  actionCorrelations: readonly ActionCommandCorrelation[];
  issuedAt: string;
}>;

export type TrustedJourneyAttestation = Readonly<{
  keyId: string;
  payload: TrustedJourneyAttestationPayload;
  signature: string;
}>;

export type JourneyAttestationIssueInput = Readonly<{
  journeyId: string;
  bundleCellId: string;
  scenarioId: string;
  outcome: JourneyOutcome;
  checkpoints: readonly FullJourneyCheckpoint[];
  manifestDigest: string;
  ledgerChecksum: string;
  observedLineageDigest: string;
  actionTraces?: readonly JourneyActionTrace[];
  actionCorrelations?: readonly ActionCommandCorrelation[];
  issuedAt?: string;
}>;

export interface RunnerOwnedEvidenceIssuer {
  issue(input: JourneyAttestationIssueInput): TrustedJourneyAttestation;
}

export interface TrustedAttestationVerifier {
  verify(attestation: TrustedJourneyAttestation): TrustedJourneyAttestationPayload;
}

export type TrustedIssuerTrustManifest = JourneyReleaseIdentity & Readonly<{
  keys: readonly Readonly<{
    issuer: Exclude<JourneyEvidenceIssuer, "superseded_protocol_fixture">;
    keyId: string;
    publicKeySpki: string;
  }>[];
}>;

export type RunnerOwnedEvidenceContext = Readonly<{
  runtimeHost: RunnerOwnedEvidenceIssuer;
  browser: RunnerOwnedEvidenceIssuer;
  electron: RunnerOwnedEvidenceIssuer;
  openCodeAcpTask: RunnerOwnedEvidenceIssuer;
  codexAcpTask: RunnerOwnedEvidenceIssuer;
  acpMeta: RunnerOwnedEvidenceIssuer;
  verifier: TrustedAttestationVerifier;
  trustManifest: TrustedIssuerTrustManifest;
}>;

const RELEASE_ISSUER_PROFILES = Object.freeze({
  runtime_host: Object.freeze({ evidenceClass: "deterministic_fake", surface: "runtime-host" }),
  browser_ui_driver: Object.freeze({ evidenceClass: "browser_rendered", surface: "browser" }),
  electron_ui_driver: Object.freeze({ evidenceClass: "electron_ipc", surface: "desktop" }),
  opencode_acp_task_attestor: Object.freeze({ evidenceClass: "qualified_acp_provider", surface: "provider" }),
  codex_acp_task_attestor: Object.freeze({ evidenceClass: "qualified_acp_provider", surface: "provider" }),
  acp_meta_attestor: Object.freeze({ evidenceClass: "qualified_acp_meta", surface: "provider" }),
} as const satisfies Partial<Record<JourneyEvidenceIssuer, Omit<JourneyEvidenceStream, "issuer">>>);

type ReleaseIssuer = keyof typeof RELEASE_ISSUER_PROFILES;

export function createRunnerOwnedEvidenceContext(matrix: JourneyReleaseMatrix): RunnerOwnedEvidenceContext {
  validateReleaseMatrix(matrix);
  const keyPairs = new Map<ReleaseIssuer, Readonly<{ privateKey: KeyObject; publicKey: KeyObject; keyId: string }>>();
  for (const issuer of Object.keys(RELEASE_ISSUER_PROFILES) as ReleaseIssuer[]) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ type: "spki", format: "der" });
    const keyId = `issuer_key_${createHash("sha256").update(publicDer).digest("hex").slice(0, 24)}`;
    keyPairs.set(issuer, Object.freeze({ privateKey, publicKey, keyId }));
  }

  const signer = (issuer: ReleaseIssuer): RunnerOwnedEvidenceIssuer => {
    const keys = keyPairs.get(issuer)!;
    const profile = RELEASE_ISSUER_PROFILES[issuer];
    return Object.freeze({
      issue(input: JourneyAttestationIssueInput): TrustedJourneyAttestation {
        validateIssueInput(input);
        const cell = matrix.cells.find((candidate) => candidate.bundleCellId === input.bundleCellId
          && candidate.scenarioId === input.scenarioId);
        if (!cell) throw new Error("journey_attestation_cell_not_declared");
        const requirement = cell.streamRequirements.find((candidate) => candidate.issuer === issuer);
        if (!requirement) throw new Error("journey_attestation_stream_not_declared");
        if (requirement.evidenceClass !== profile.evidenceClass || requirement.surface !== profile.surface) {
          throw new Error("journey_attestation_stream_profile_invalid");
        }
        validateCheckpointCoverage(input.outcome, input.checkpoints, requirement.checkpoints, cell.required);

        const actionTraces = Object.freeze([...(input.actionTraces ?? [])]);
        const actionCorrelations = Object.freeze([...(input.actionCorrelations ?? [])]);
        if ((issuer === "browser_ui_driver" || issuer === "electron_ui_driver") && input.outcome === "PASS") {
          if (actionTraces.length === 0 || actionCorrelations.length === 0) {
            throw new Error("journey_attestation_ui_action_evidence_required");
          }
          verifyActionCommandCorrelation(actionTraces, actionCorrelations);
          for (const correlation of actionCorrelations) {
            if (correlation.scenarioId !== cell.scenarioId
              || correlation.runtimeInstanceId !== cell.lineage.runtimeInstanceId) {
              throw new Error("journey_attestation_ui_action_lineage_mismatch");
            }
          }
        } else if (actionTraces.length > 0 || actionCorrelations.length > 0) {
          throw new Error("journey_attestation_action_evidence_wrong_issuer");
        }

        const result: JourneyEvidenceCellResult = Object.freeze({
          journeyId: input.journeyId,
          releaseRunId: matrix.releaseRunId,
          nonce: matrix.nonce,
          digests: matrix.digests,
          bundleCellId: cell.bundleCellId,
          scenarioId: cell.scenarioId,
          lineage: cell.lineage,
          issuer,
          evidenceClass: profile.evidenceClass,
          surface: profile.surface,
          outcome: input.outcome,
        });
        const payload = deepFreeze({
          result,
          checkpoints: [...input.checkpoints],
          manifestDigest: input.manifestDigest,
          ledgerChecksum: input.ledgerChecksum,
          observedLineageDigest: input.observedLineageDigest,
          actionTraces,
          actionCorrelations,
          issuedAt: input.issuedAt ?? new Date().toISOString(),
        }) as TrustedJourneyAttestationPayload;
        validateAttestationPayload(payload);
        const signature = signBytes(null, Buffer.from(canonicalJson(payload)), keys.privateKey).toString("base64url");
        return deepFreeze({ keyId: keys.keyId, payload, signature }) as TrustedJourneyAttestation;
      },
    });
  };

  const publicKeys = new Map<ReleaseIssuer, Readonly<{ publicKey: KeyObject; keyId: string }>>(
    [...keyPairs].map(([issuer, { publicKey, keyId }]) => [issuer, Object.freeze({ publicKey, keyId })]),
  );
  const verifier: TrustedAttestationVerifier = Object.freeze({
    verify(attestation: TrustedJourneyAttestation): TrustedJourneyAttestationPayload {
      validateAttestation(attestation);
      const issuer = attestation.payload.result.issuer;
      if (!(issuer in RELEASE_ISSUER_PROFILES)) throw new Error("journey_attestation_issuer_untrusted");
      const keys = publicKeys.get(issuer as ReleaseIssuer)!;
      if (attestation.keyId !== keys.keyId) throw new Error("journey_attestation_key_mismatch");
      const signature = Buffer.from(attestation.signature, "base64url");
      if (!verifyBytes(null, Buffer.from(canonicalJson(attestation.payload)), keys.publicKey, signature)) {
        throw new Error("journey_attestation_signature_invalid");
      }
      return attestation.payload;
    },
  });
  const trustManifest = deepFreeze({
    releaseRunId: matrix.releaseRunId,
    nonce: matrix.nonce,
    digests: matrix.digests,
    keys: [...publicKeys].map(([issuer, { publicKey, keyId }]) => ({
      issuer,
      keyId,
      publicKeySpki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    })),
  }) as TrustedIssuerTrustManifest;

  return Object.freeze({
    runtimeHost: signer("runtime_host"),
    browser: signer("browser_ui_driver"),
    electron: signer("electron_ui_driver"),
    openCodeAcpTask: signer("opencode_acp_task_attestor"),
    codexAcpTask: signer("codex_acp_task_attestor"),
    acpMeta: signer("acp_meta_attestor"),
    verifier,
    trustManifest,
  });
}

export function toSharedEvidenceMatrix(matrix: JourneyReleaseMatrix): JourneyEvidenceMatrix {
  validateReleaseMatrix(matrix);
  return Object.freeze({
    releaseRunId: matrix.releaseRunId,
    nonce: matrix.nonce,
    digests: matrix.digests,
    cells: Object.freeze(matrix.cells.map((cell) => Object.freeze({
      bundleCellId: cell.bundleCellId,
      scenarioId: cell.scenarioId,
      lineage: cell.lineage,
      required: cell.required,
      streams: Object.freeze(cell.streamRequirements.map(({ checkpoints: _checkpoints, ...stream }) => Object.freeze(stream))),
    }))),
  });
}

export function verifyTrustedAttestations(
  matrix: JourneyReleaseMatrix,
  attestations: readonly TrustedJourneyAttestation[],
  verifier: TrustedAttestationVerifier,
): readonly TrustedJourneyAttestationPayload[] {
  validateReleaseMatrix(matrix);
  if (!Array.isArray(attestations)) throw new Error("journey_attestations_invalid");
  const payloads = attestations.map((attestation) => verifier.verify(attestation));
  const observed = new Set<string>();
  const observedCommandIds = new Set<string>();
  const observedUiIntentIds = new Set<string>();
  const lineageDigestByCell = new Map<string, string>();
  const cellByLineageDigest = new Map<string, string>();
  for (const payload of payloads) {
    const { result } = payload;
    const cell = matrix.cells.find((candidate) => candidate.bundleCellId === result.bundleCellId
      && candidate.scenarioId === result.scenarioId);
    if (!cell) throw new Error("journey_attestation_cell_not_declared");
    const requirement = cell.streamRequirements.find((candidate) => candidate.issuer === result.issuer
      && candidate.evidenceClass === result.evidenceClass
      && candidate.surface === result.surface);
    if (!requirement) throw new Error("journey_attestation_stream_not_declared");
    validateCheckpointCoverage(result.outcome, payload.checkpoints, requirement.checkpoints, cell.required);
    const cellKey = `${result.bundleCellId}\0${result.scenarioId}`;
    const previousDigest = lineageDigestByCell.get(cellKey);
    if (previousDigest && previousDigest !== payload.observedLineageDigest) {
      throw new Error("journey_attestation_cell_lineage_digest_mismatch");
    }
    const previousCell = cellByLineageDigest.get(payload.observedLineageDigest);
    if (previousCell && previousCell !== cellKey) {
      throw new Error("journey_attestation_cross_cell_lineage_digest_reused");
    }
    lineageDigestByCell.set(cellKey, payload.observedLineageDigest);
    cellByLineageDigest.set(payload.observedLineageDigest, cellKey);
    for (const correlation of payload.actionCorrelations) {
      if (observedCommandIds.has(correlation.commandId) || observedUiIntentIds.has(correlation.uiIntentId)) {
        throw new Error("journey_attestation_cross_cell_action_identity_reused");
      }
      observedCommandIds.add(correlation.commandId);
      observedUiIntentIds.add(correlation.uiIntentId);
    }
    const key = `${result.bundleCellId}\0${result.scenarioId}\0${result.issuer}`;
    if (observed.has(key)) throw new Error("journey_attestation_stream_duplicate");
    observed.add(key);
  }
  validateAcpCompanionAttestations(matrix, payloads);
  verifyJourneyEvidenceMatrix(toSharedEvidenceMatrix(matrix), payloads.map(({ result }) => result));
  return Object.freeze(payloads);
}

function validateAcpCompanionAttestations(
  matrix: JourneyReleaseMatrix,
  payloads: readonly TrustedJourneyAttestationPayload[],
): void {
  for (const cell of matrix.cells) {
    const providerRequirement = cell.streamRequirements.find(({ issuer }) => (
      issuer === "opencode_acp_task_attestor"
      || issuer === "codex_acp_task_attestor"
      || issuer === "acp_meta_attestor"
    ));
    if (!providerRequirement) continue;
    const cellPayloads = payloads.filter(({ result }) => (
      result.bundleCellId === cell.bundleCellId && result.scenarioId === cell.scenarioId
    ));
    const provider = cellPayloads.find(({ result }) => result.issuer === providerRequirement.issuer);
    const runtimeRequirement = cell.streamRequirements.find(({ issuer }) => issuer === "runtime_host");
    const runtime = cellPayloads.find(({ result }) => result.issuer === "runtime_host");
    const uiRequirements = cell.streamRequirements.filter(({ issuer }) => (
      issuer === "browser_ui_driver" || issuer === "electron_ui_driver"
    ));
    const ui = uiRequirements.map((requirement) => cellPayloads.find(({ result }) => (
      result.issuer === requirement.issuer
    )));
    if (!provider || provider.result.outcome !== "PASS"
      || !runtimeRequirement || !runtime || runtime.result.outcome !== "PASS"
      || uiRequirements.length === 0 || ui.some((payload) => !payload || payload.result.outcome !== "PASS")) {
      throw new Error("journey_acp_companion_attestation_missing");
    }
    const providerCheckpoints = new Set(providerRequirement.checkpoints);
    const runtimeCheckpoints = new Set(runtimeRequirement.checkpoints);
    const uiCheckpoints = new Set(uiRequirements.flatMap(({ checkpoints }) => checkpoints));
    if (providerCheckpoints.size !== runtimeCheckpoints.size
      || [...providerCheckpoints].some((checkpoint) => !runtimeCheckpoints.has(checkpoint))
      || [...providerCheckpoints].some((checkpoint) => !uiCheckpoints.has(checkpoint))) {
      throw new Error("journey_acp_companion_attestation_coverage_invalid");
    }
    const lineageDigests = new Set([provider, runtime, ...ui]
      .filter((payload): payload is TrustedJourneyAttestationPayload => Boolean(payload))
      .map(({ observedLineageDigest }) => observedLineageDigest));
    if (lineageDigests.size !== 1) {
      throw new Error("journey_acp_companion_attestation_lineage_mismatch");
    }
  }
}

function validateReleaseMatrix(matrix: JourneyReleaseMatrix): void {
  if (!matrix || typeof matrix !== "object"
    || !/^release_[A-Za-z0-9-]+$/.test(matrix.releaseRunId)
    || typeof matrix.nonce !== "string"
    || matrix.nonce.length < 16
    || !Array.isArray(matrix.cells)
    || matrix.cells.length === 0) {
    throw new Error("journey_release_matrix_invalid");
  }
  validateDigestRecord(matrix.digests);
  const cells = new Set<string>();
  for (const cell of matrix.cells) {
    const key = `${cell.bundleCellId}\0${cell.scenarioId}`;
    if (!/^cell_[A-Za-z0-9-]+$/.test(cell.bundleCellId)
      || !/^scenario_[A-Za-z0-9-]+$/.test(cell.scenarioId)
      || typeof cell.required !== "boolean"
      || cells.has(key)
      || !Array.isArray(cell.streamRequirements)
      || cell.streamRequirements.length === 0) {
      throw new Error("journey_release_cell_invalid");
    }
    cells.add(key);
    validateLineage(cell.lineage);
    const issuers = new Set<string>();
    for (const requirement of cell.streamRequirements) {
      const profile = RELEASE_ISSUER_PROFILES[requirement.issuer as ReleaseIssuer];
      if (!profile
        || profile.evidenceClass !== requirement.evidenceClass
        || profile.surface !== requirement.surface
        || issuers.has(requirement.issuer)) {
        throw new Error("journey_release_stream_invalid");
      }
      issuers.add(requirement.issuer);
      validateCheckpointList(requirement.checkpoints, false);
    }
  }
}

function validateIssueInput(input: JourneyAttestationIssueInput): void {
  const allowed = [
    "journeyId", "bundleCellId", "scenarioId", "outcome", "checkpoints", "manifestDigest", "ledgerChecksum",
    "observedLineageDigest",
    "actionTraces", "actionCorrelations", "issuedAt",
  ];
  if (!input || typeof input !== "object"
    || Object.keys(input).some((key) => !allowed.includes(key))
    || !/^journey_[A-Za-z0-9-]+$/.test(input.journeyId)
    || !/^cell_[A-Za-z0-9-]+$/.test(input.bundleCellId)
    || !/^scenario_[A-Za-z0-9-]+$/.test(input.scenarioId)
    || !["PASS", "FAIL", "BLOCKED_CAPABILITY", "NOT_EXERCISED", "NOT_APPLICABLE"].includes(input.outcome)) {
    throw new Error("journey_attestation_issue_input_invalid");
  }
  validateCheckpointList(input.checkpoints, true);
  validateDigest(input.manifestDigest);
  validateDigest(input.ledgerChecksum);
  validateDigest(input.observedLineageDigest);
  if (input.issuedAt !== undefined && !isCanonicalTimestamp(input.issuedAt)) {
    throw new Error("journey_attestation_issued_at_invalid");
  }
}

function validateAttestation(attestation: TrustedJourneyAttestation): void {
  if (!attestation || typeof attestation !== "object"
    || Object.keys(attestation).some((key) => !["keyId", "payload", "signature"].includes(key))
    || !/^issuer_key_[a-f0-9]{24}$/.test(attestation.keyId)
    || typeof attestation.signature !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(attestation.signature)) {
    throw new Error("journey_attestation_invalid");
  }
  validateAttestationPayload(attestation.payload);
}

function validateAttestationPayload(payload: TrustedJourneyAttestationPayload): void {
  if (!payload || typeof payload !== "object"
    || Object.keys(payload).some((key) => ![
      "result", "checkpoints", "manifestDigest", "ledgerChecksum", "observedLineageDigest",
      "actionTraces", "actionCorrelations", "issuedAt",
    ].includes(key))
    || !isCanonicalTimestamp(payload.issuedAt)) {
    throw new Error("journey_attestation_payload_invalid");
  }
  validateCheckpointList(payload.checkpoints, true);
  validateDigest(payload.manifestDigest);
  validateDigest(payload.ledgerChecksum);
  validateDigest(payload.observedLineageDigest);
  if (!Array.isArray(payload.actionTraces) || !Array.isArray(payload.actionCorrelations)) {
    throw new Error("journey_attestation_payload_invalid");
  }
}

function validateCheckpointCoverage(
  outcome: JourneyOutcome,
  actual: readonly FullJourneyCheckpoint[],
  expected: readonly FullJourneyCheckpoint[],
  required: boolean,
): void {
  validateCheckpointList(actual, true);
  validateCheckpointList(expected, false);
  if (outcome === "NOT_APPLICABLE" && required) throw new Error("journey_required_not_applicable_forbidden");
  if (outcome === "PASS" && !sameStringSet(actual, expected)) {
    throw new Error("journey_attestation_checkpoint_coverage_incomplete");
  }
  if (actual.some((checkpoint) => !expected.includes(checkpoint))) {
    throw new Error("journey_attestation_checkpoint_not_declared");
  }
}

function validateCheckpointList(checkpoints: readonly FullJourneyCheckpoint[], allowEmpty: boolean): void {
  if (!Array.isArray(checkpoints)
    || (!allowEmpty && checkpoints.length === 0)
    || new Set(checkpoints).size !== checkpoints.length
    || checkpoints.some((checkpoint) => !/^J-(?:0[1-9]|1[0-2])$/.test(checkpoint))) {
    throw new Error("journey_attestation_checkpoints_invalid");
  }
}

function validateDigestRecord(digests: JourneyReleaseIdentity["digests"]): void {
  if (!digests || typeof digests !== "object"
    || Object.keys(digests).sort().join(",") !== "buildDigest,policyDigest,providerPolicyDigest,schemaDigest,sourceDigest") {
    throw new Error("journey_release_digests_invalid");
  }
  for (const digest of Object.values(digests)) validateDigest(digest);
}

function validateDigest(digest: unknown): asserts digest is string {
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("journey_release_digest_invalid");
  }
}

function validateLineage(lineage: JourneyEvidenceLineage): void {
  if (!lineage || typeof lineage !== "object"
    || Object.keys(lineage).length !== 1
    || Object.keys(lineage)[0] !== "runtimeInstanceId"
    || !/^runtime_instance_[A-Za-z0-9-]+$/.test(lineage.runtimeInstanceId)) {
    throw new Error("journey_release_lineage_invalid");
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}
