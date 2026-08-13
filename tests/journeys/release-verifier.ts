import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  FULL_JOURNEY_CHECKPOINTS,
  type FullJourneyCheckpoint,
  type JourneyEvidenceDigests,
  type JourneyEvidenceLineage,
  type JourneyReleaseIdentity,
} from "../e2e/journey-evidence.js";
import {
  verifyTrustedAttestations,
  type JourneyReleaseCellDeclaration,
  type JourneyReleaseMatrix,
  type JourneyStreamRequirement,
  type TrustedAttestationVerifier,
  type TrustedJourneyAttestation,
  type TrustedJourneyAttestationPayload,
} from "./evidence-issuers.js";

export type ReleaseDigestInputs = Readonly<{
  source: string | Uint8Array;
  build: string | Uint8Array;
  schema: string | Uint8Array;
  providerPolicy: string | Uint8Array;
  policy: string | Uint8Array;
}>;

export type JourneyReleaseVerification = Readonly<{
  releaseRunId: string;
  nonce: string;
  requiredCells: number;
  attestations: number;
  checkpoints: readonly FullJourneyCheckpoint[];
}>;

const J01_TO_J11 = FULL_JOURNEY_CHECKPOINTS.filter((checkpoint) => checkpoint !== "J-12");
const J01_TO_J06 = FULL_JOURNEY_CHECKPOINTS.filter((checkpoint) => Number(checkpoint.slice(2)) <= 6);
const J07_TO_J11 = FULL_JOURNEY_CHECKPOINTS.filter((checkpoint) => {
  const value = Number(checkpoint.slice(2));
  return value >= 7 && value <= 11;
});
const J04_TO_J10 = FULL_JOURNEY_CHECKPOINTS.filter((checkpoint) => {
  const value = Number(checkpoint.slice(2));
  return value >= 4 && value <= 10;
});
const J04_TO_J12 = FULL_JOURNEY_CHECKPOINTS.filter((checkpoint) => {
  const value = Number(checkpoint.slice(2));
  return value >= 4 && value <= 12;
});

const HUMAN_BRANCHES = ["unknown", "late-final"] as const;
const CRASH_POINTS = ["pending-lane", "tool-result", "provider-accepted", "human-interrupting", "final-before-inbox"] as const;

export function createFreshReleaseIdentity(inputs: ReleaseDigestInputs): JourneyReleaseIdentity {
  const suffix = randomBytes(12).toString("hex");
  return Object.freeze({
    releaseRunId: `release_${suffix}`,
    nonce: `nonce_${randomBytes(24).toString("base64url")}`,
    digests: Object.freeze({
      sourceDigest: digest(inputs.source),
      buildDigest: digest(inputs.build),
      schemaDigest: digest(inputs.schema),
      providerPolicyDigest: digest(inputs.providerPolicy),
      policyDigest: digest(inputs.policy),
    }),
  });
}

export function createRequiredJourneyReleaseMatrix(
  release: JourneyReleaseIdentity,
  lineageFactory: (cellName: string) => JourneyEvidenceLineage = defaultLineage,
): JourneyReleaseMatrix {
  const cells: JourneyReleaseCellDeclaration[] = [];
  cells.push(...controlledBundleCells("bridge-fake", "runtime"));
  cells.push(...controlledBundleCells("browser-controlled", "browser"));
  cells.push(...controlledBundleCells("electron-controlled", "electron"));

  cells.push(cell(
    "cross-surface-continuity",
    "cross-surface-continuity",
    lineageFactory,
    [
      requirement("browser", [...J01_TO_J06, "J-12"]),
      requirement("electron", [...J07_TO_J11, "J-12"]),
      requirement("runtime", FULL_JOURNEY_CHECKPOINTS),
    ],
  ));

  cells.push(acpTaskCell("opencode", "opencode-acp-task"));
  cells.push(acpTaskCell("codex", "codex-acp-task"));
  cells.push(cell(
    "acp-meta",
    "acp-meta",
    lineageFactory,
    [
      requirement("browser", ["J-02", "J-03"]),
      requirement("runtime", ["J-02", "J-03"]),
      requirement("acp-meta", ["J-02", "J-03"]),
    ],
  ));

  function acpTaskCell(
    provider: "opencode" | "codex",
    cellName: "opencode-acp-task" | "codex-acp-task",
  ): JourneyReleaseCellDeclaration {
    return cell(cellName, cellName, lineageFactory, [
      requirement("browser", ["J-04", "J-05", "J-06", "J-12"]),
      requirement("electron", ["J-07", "J-08", "J-09", "J-10", "J-11", "J-12"]),
      requirement("runtime", J04_TO_J12),
      requirement(provider === "opencode" ? "opencode-acp-task" : "codex-acp-task", J04_TO_J12),
    ]);
  }

  function controlledBundleCells(
    bundle: "bridge-fake" | "browser-controlled" | "electron-controlled",
    surface: "runtime" | "browser" | "electron",
  ): readonly JourneyReleaseCellDeclaration[] {
    const mainRequirements = surface === "runtime"
      ? [requirement("runtime", J04_TO_J10)]
      : [requirement(surface, J01_TO_J11), requirement("runtime", J01_TO_J11)];
    const branchRequirements = (checkpoint: FullJourneyCheckpoint) => surface === "runtime"
      ? [requirement("runtime", [checkpoint])]
      : [requirement(surface, [checkpoint]), requirement("runtime", [checkpoint])];
    return [
      cell(`${bundle}-main`, `${bundle}-main`, lineageFactory, mainRequirements),
      ...HUMAN_BRANCHES.map((branch) => cell(
        `${bundle}-j08-${branch}`,
        `${bundle}-j08-${branch}`,
        lineageFactory,
        branchRequirements("J-08"),
      )),
      ...CRASH_POINTS.map((point) => cell(
        `${bundle}-j10-${point}`,
        `${bundle}-j10-${point}`,
        lineageFactory,
        branchRequirements("J-10"),
      )),
    ];
  }

  return deepFreeze({
    releaseRunId: release.releaseRunId,
    nonce: release.nonce,
    digests: normalizeDigests(release.digests),
    cells,
  }) as JourneyReleaseMatrix;
}

export function verifyReleaseBundle(input: Readonly<{
  matrix: JourneyReleaseMatrix;
  attestations: readonly TrustedJourneyAttestation[];
  verifier: TrustedAttestationVerifier;
}>): JourneyReleaseVerification {
  assertExactRequiredJourneyReleaseMatrix(input.matrix);
  const payloads = verifyTrustedAttestations(input.matrix, input.attestations, input.verifier);
  assertEveryCheckpointIsRequired(input.matrix);
  return Object.freeze({
    releaseRunId: input.matrix.releaseRunId,
    nonce: input.matrix.nonce,
    requiredCells: input.matrix.cells.filter(({ required }) => required).length,
    attestations: payloads.length,
    checkpoints: Object.freeze([...FULL_JOURNEY_CHECKPOINTS]),
  });
}

export function readVerifiedPayloads(input: Readonly<{
  matrix: JourneyReleaseMatrix;
  attestations: readonly TrustedJourneyAttestation[];
  verifier: TrustedAttestationVerifier;
}>): readonly TrustedJourneyAttestationPayload[] {
  return verifyTrustedAttestations(input.matrix, input.attestations, input.verifier);
}

function cell(
  cellName: string,
  scenarioName: string,
  lineageFactory: (cellName: string) => JourneyEvidenceLineage,
  streamRequirements: readonly JourneyStreamRequirement[],
): JourneyReleaseCellDeclaration {
  return deepFreeze({
    bundleCellId: `cell_${cellName}`,
    scenarioId: `scenario_${scenarioName}`,
    lineage: lineageFactory(cellName),
    required: true,
    streamRequirements,
  }) as JourneyReleaseCellDeclaration;
}

function requirement(
  kind: "runtime" | "browser" | "electron" | "opencode-acp-task" | "codex-acp-task" | "acp-meta",
  checkpoints: readonly FullJourneyCheckpoint[],
): JourneyStreamRequirement {
  const profiles = {
    runtime: { issuer: "runtime_host", evidenceClass: "deterministic_fake", surface: "runtime-host" },
    browser: { issuer: "browser_ui_driver", evidenceClass: "browser_rendered", surface: "browser" },
    electron: { issuer: "electron_ui_driver", evidenceClass: "electron_ipc", surface: "desktop" },
    "opencode-acp-task": { issuer: "opencode_acp_task_attestor", evidenceClass: "qualified_acp_provider", surface: "provider" },
    "codex-acp-task": { issuer: "codex_acp_task_attestor", evidenceClass: "qualified_acp_provider", surface: "provider" },
    "acp-meta": { issuer: "acp_meta_attestor", evidenceClass: "qualified_acp_meta", surface: "provider" },
  } as const;
  return deepFreeze({ ...profiles[kind], checkpoints: [...checkpoints] }) as JourneyStreamRequirement;
}

function defaultLineage(cellName: string): JourneyEvidenceLineage {
  const suffix = cellName.replace(/[^A-Za-z0-9-]/g, "-");
  return deepFreeze({
    runtimeInstanceId: `runtime_instance_${suffix}`,
  }) as JourneyEvidenceLineage;
}

function assertExactRequiredJourneyReleaseMatrix(matrix: JourneyReleaseMatrix): void {
  if (!matrix || typeof matrix !== "object" || !Array.isArray(matrix.cells) || matrix.cells.length !== 28) {
    throw new Error("journey_release_matrix_not_exact_28");
  }
  const cellsById = new Map(matrix.cells.map((candidate) => [candidate?.bundleCellId, candidate]));
  const expected = createRequiredJourneyReleaseMatrix(matrix, (cellName) => {
    const actual = cellsById.get(`cell_${cellName}`);
    return actual?.lineage && typeof actual.lineage.runtimeInstanceId === "string"
      ? { runtimeInstanceId: actual.lineage.runtimeInstanceId }
      : defaultLineage(cellName);
  });
  if (!isDeepStrictEqual(matrix, expected)) {
    throw new Error("journey_release_matrix_not_exact_28");
  }
}

function assertEveryCheckpointIsRequired(matrix: JourneyReleaseMatrix): void {
  const checkpoints = new Set<FullJourneyCheckpoint>();
  for (const cell of matrix.cells) {
    if (!cell.required) continue;
    for (const requirement of cell.streamRequirements) {
      requirement.checkpoints.forEach((checkpoint) => checkpoints.add(checkpoint));
    }
  }
  for (const checkpoint of FULL_JOURNEY_CHECKPOINTS) {
    if (!checkpoints.has(checkpoint)) throw new Error("journey_release_checkpoint_missing_from_matrix");
  }
}

function normalizeDigests(digests: JourneyEvidenceDigests): JourneyEvidenceDigests {
  const expected = ["sourceDigest", "buildDigest", "schemaDigest", "providerPolicyDigest", "policyDigest"] as const;
  const result = {} as Record<(typeof expected)[number], string>;
  for (const field of expected) {
    const value = digests[field];
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("journey_release_digest_invalid");
    result[field] = value;
  }
  return Object.freeze(result) as JourneyEvidenceDigests;
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}
