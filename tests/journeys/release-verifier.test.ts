import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FullJourneyCheckpoint, JourneyEvidenceLineage, JourneyOutcome } from "../e2e/journey-evidence.js";
import {
  createRunnerOwnedEvidenceContext,
  verifyTrustedAttestations,
  type JourneyAttestationIssueInput,
  type JourneyReleaseCellDeclaration,
  type JourneyReleaseMatrix,
  type JourneyStreamRequirement,
  type RunnerOwnedEvidenceContext,
  type RunnerOwnedEvidenceIssuer,
  type TrustedJourneyAttestation,
} from "./evidence-issuers.js";
import {
  createFreshReleaseIdentity,
  createRequiredJourneyReleaseMatrix,
  verifyReleaseBundle,
} from "./release-verifier.js";
import type { ActionCommandCorrelation, JourneyActionTrace } from "./locator-action-dsl.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("Phase 8 ACP release evidence", () => {
  it("freezes the exact 28-cell controlled, cross-surface, ACP Task and ACP Meta matrix", () => {
    const matrix = requiredMatrix();
    const checkpoints = new Set(matrix.cells.flatMap(({ streamRequirements }) =>
      streamRequirements.flatMap(({ checkpoints: values }) => values)));
    expect([...checkpoints].sort()).toEqual([
      "J-01", "J-02", "J-03", "J-04", "J-05", "J-06", "J-07", "J-08", "J-09", "J-10", "J-11", "J-12",
    ]);
    expect(matrix.cells).toHaveLength(28);
    expect(matrix.cells.filter(({ scenarioId }) => scenarioId.includes("j08"))).toHaveLength(6);
    expect(matrix.cells.filter(({ scenarioId }) => scenarioId.includes("j10"))).toHaveLength(15);
    expect(matrix.cells.slice(-3).map(({ bundleCellId }) => bundleCellId)).toEqual([
      "cell_opencode-acp-task",
      "cell_codex-acp-task",
      "cell_acp-meta",
    ]);
    expect(taskAcpStreams(matrix, "cell_opencode-acp-task", "opencode_acp_task_attestor"))
      .toEqual(expectedTaskAcpStreams("opencode_acp_task_attestor"));
    expect(taskAcpStreams(matrix, "cell_codex-acp-task", "codex_acp_task_attestor"))
      .toEqual(expectedTaskAcpStreams("codex_acp_task_attestor"));
    expect(matrix.cells.find(({ bundleCellId }) => bundleCellId === "cell_acp-meta")?.streamRequirements)
      .toEqual([
        {
          issuer: "browser_ui_driver",
          evidenceClass: "browser_rendered",
          surface: "browser",
          checkpoints: ["J-02", "J-03"],
        },
        {
          issuer: "runtime_host",
          evidenceClass: "deterministic_fake",
          surface: "runtime-host",
          checkpoints: ["J-02", "J-03"],
        },
        {
          issuer: "acp_meta_attestor",
          evidenceClass: "qualified_acp_meta",
          surface: "provider",
          checkpoints: ["J-02", "J-03"],
        },
      ]);
    expect(Object.isFrozen(matrix)).toBe(true);
    expect(Object.isFrozen(matrix.cells)).toBe(true);
  });

  it("accepts only a complete same-release bundle signed by each runner-owned issuer", () => {
    const matrix = requiredMatrix();
    const context = createRunnerOwnedEvidenceContext(matrix);
    const attestations = issueAllPass(matrix, context);
    expect(verifyReleaseBundle({ matrix, attestations, verifier: context.verifier })).toMatchObject({
      releaseRunId: matrix.releaseRunId,
      nonce: matrix.nonce,
      requiredCells: 28,
      attestations: attestations.length,
      checkpoints: ["J-01", "J-02", "J-03", "J-04", "J-05", "J-06", "J-07", "J-08", "J-09", "J-10", "J-11", "J-12"],
    });
  });

  it("rejects a signed all-PASS bundle when one canonical redundant cell is missing", () => {
    const canonical = requiredMatrix();
    const matrix = {
      ...canonical,
      cells: canonical.cells.filter(({ bundleCellId }) => bundleCellId !== "cell_bridge-fake-j08-unknown"),
    } as JourneyReleaseMatrix;
    const context = createRunnerOwnedEvidenceContext(matrix);
    const attestations = issueAllPass(matrix, context);

    expect(() => verifyReleaseBundle({ matrix, attestations, verifier: context.verifier }))
      .toThrow("journey_release_matrix_not_exact_28");
  });

  it.each(EXACT_MATRIX_DRIFT_CASES)("rejects a signed all-PASS bundle with %s", (_label, mutate) => {
    const matrix = mutate(requiredMatrix());
    const context = createRunnerOwnedEvidenceContext(matrix);
    const attestations = issueAllPass(matrix, context);

    expect(() => verifyReleaseBundle({ matrix, attestations, verifier: context.verifier }))
      .toThrow("journey_release_matrix_not_exact_28");
  });

  it("rejects scenario authority fields, forged class/issuer and unsigned FakeProvider ACP claims", () => {
    const matrix = requiredMatrix();
    const context = createRunnerOwnedEvidenceContext(matrix);
    const cell = matrix.cells.find(({ bundleCellId }) => bundleCellId === "cell_browser-controlled-main")!;
    expect(() => context.browser.issue({
      ...issueInput(cell, cell.streamRequirements.find(({ issuer }) => issuer === "browser_ui_driver")!),
      evidenceClass: "qualified_acp_provider",
    } as JourneyAttestationIssueInput)).toThrow("journey_attestation_issue_input_invalid");

    const valid = context.browser.issue(issueInput(
      cell,
      cell.streamRequirements.find(({ issuer }) => issuer === "browser_ui_driver")!,
    ));
    const forged = {
      ...valid,
      payload: {
        ...valid.payload,
        result: {
          ...valid.payload.result,
          issuer: "opencode_acp_task_attestor",
          evidenceClass: "qualified_acp_provider",
          surface: "provider",
        },
      },
    } as TrustedJourneyAttestation;
    expect(() => context.verifier.verify(forged)).toThrow();

    const nativeCell = matrix.cells.find(({ bundleCellId }) => bundleCellId === "cell_opencode-acp-task")!;
    const onlyRuntime = context.runtimeHost.issue(issueInput(
      nativeCell,
      nativeCell.streamRequirements.find(({ issuer }) => issuer === "runtime_host")!,
    ));
    expect(() => verifyReleaseBundle({ matrix, attestations: [onlyRuntime], verifier: context.verifier }))
      .toThrow("journey_acp_companion_attestation_missing");
  });

  it("rejects required N/A, NOT_EXERCISED, stale release identity, cross-lineage substitution and bundle stitching", () => {
    const matrix = oneCellMatrix(true);
    const context = createRunnerOwnedEvidenceContext(matrix);
    const cell = matrix.cells[0]!;
    const requirement = cell.streamRequirements[0]!;
    expect(() => context.runtimeHost.issue(issueInput(cell, requirement, "NOT_APPLICABLE")))
      .toThrow("journey_required_not_applicable_forbidden");

    const notExercised = context.runtimeHost.issue(issueInput(cell, requirement, "NOT_EXERCISED"));
    expect(() => verifyTrustedAttestations(matrix, [notExercised], context.verifier))
      .toThrow("journey_evidence_required_cell_not_pass");

    const pass = context.runtimeHost.issue(issueInput(cell, requirement));
    const staleMatrix = { ...matrix, nonce: "nonce_stale_release_0001" } as JourneyReleaseMatrix;
    expect(() => verifyTrustedAttestations(staleMatrix, [pass], context.verifier))
      .toThrow("journey_evidence_release_mismatch");

    const crossLineage = {
      ...matrix,
      cells: [{
        ...cell,
        lineage: { ...cell.lineage, runtimeInstanceId: "runtime_instance_other-lineage" },
      }],
    } as JourneyReleaseMatrix;
    expect(() => verifyTrustedAttestations(crossLineage, [pass], context.verifier))
      .toThrow("journey_evidence_cell_lineage_mismatch");

    const otherContext = createRunnerOwnedEvidenceContext(matrix);
    const otherPass = otherContext.runtimeHost.issue(issueInput(cell, requirement));
    expect(() => verifyTrustedAttestations(matrix, [otherPass], context.verifier))
      .toThrow("journey_attestation_key_mismatch");
  });

  it("allows NOT_APPLICABLE only for an optional predeclared cell", () => {
    const matrix = oneCellMatrix(false);
    const context = createRunnerOwnedEvidenceContext(matrix);
    const cell = matrix.cells[0]!;
    const attestation = context.runtimeHost.issue(issueInput(cell, cell.streamRequirements[0]!, "NOT_APPLICABLE"));
    expect(() => verifyTrustedAttestations(matrix, [attestation], context.verifier)).not.toThrow();
  });

  it("rejects undeclared cells, incomplete PASS checkpoint sets, missing UI correlations and signature mutation", () => {
    const matrix = requiredMatrix();
    const context = createRunnerOwnedEvidenceContext(matrix);
    const browserCell = matrix.cells.find(({ bundleCellId }) => bundleCellId === "cell_browser-controlled-main")!;
    const browserRequirement = browserCell.streamRequirements.find(({ issuer }) => issuer === "browser_ui_driver")!;
    expect(() => context.browser.issue({
      ...issueInput(browserCell, browserRequirement),
      bundleCellId: "cell_not-declared",
      scenarioId: "scenario_not-declared",
    })).toThrow("journey_attestation_cell_not_declared");
    expect(() => context.browser.issue({
      ...issueInput(browserCell, browserRequirement),
      checkpoints: browserRequirement.checkpoints.slice(1),
    })).toThrow("journey_attestation_checkpoint_coverage_incomplete");
    expect(() => context.browser.issue({
      ...issueInput(browserCell, browserRequirement),
      actionTraces: [],
      actionCorrelations: [],
    })).toThrow("journey_attestation_ui_action_evidence_required");

    const valid = context.browser.issue(issueInput(browserCell, browserRequirement));
    const mutated = {
      ...valid,
      payload: { ...valid.payload, ledgerChecksum: `sha256:${"b".repeat(64)}` },
    } as TrustedJourneyAttestation;
    expect(() => context.verifier.verify(mutated)).toThrow("journey_attestation_signature_invalid");
  });

  it("requires ACP Provider evidence to have same-cell UI, Runtime, checkpoint and lineage companions", () => {
    const base = requiredMatrix();
    const sourceCell = base.cells.find(({ bundleCellId }) => bundleCellId === "cell_opencode-acp-task")!;
    const matrix = { ...base, cells: [sourceCell] } as JourneyReleaseMatrix;
    const context = createRunnerOwnedEvidenceContext(matrix);
    const issued = issueAllPass(matrix, context);
    const withoutRuntime = issued.filter(({ payload }) => payload.result.issuer !== "runtime_host");
    expect(() => verifyTrustedAttestations(matrix, withoutRuntime, context.verifier))
      .toThrow("journey_acp_companion_attestation_missing");

    const runtimeRequirement = sourceCell.streamRequirements.find(({ issuer }) => issuer === "runtime_host")!;
    const mismatchedMatrix = {
      ...matrix,
      cells: [{
        ...sourceCell,
        streamRequirements: sourceCell.streamRequirements.map((requirement) => (
          requirement.issuer === "runtime_host"
            ? { ...runtimeRequirement, checkpoints: runtimeRequirement.checkpoints.slice(0, -1) }
            : requirement
        )),
      }],
    } as JourneyReleaseMatrix;
    const mismatchedContext = createRunnerOwnedEvidenceContext(mismatchedMatrix);
    expect(() => verifyTrustedAttestations(
      mismatchedMatrix,
      issueAllPass(mismatchedMatrix, mismatchedContext),
      mismatchedContext.verifier,
    )).toThrow("journey_acp_companion_attestation_coverage_invalid");

    const browserRequirement = sourceCell.streamRequirements.find(({ issuer }) => issuer === "browser_ui_driver")!;
    const browser = context.browser.issue({
      ...issueInput(sourceCell, browserRequirement),
      observedLineageDigest: `sha256:${"f".repeat(64)}`,
    });
    expect(() => verifyTrustedAttestations(
      matrix,
      issued.map((attestation) => attestation.payload.result.issuer === "browser_ui_driver" ? browser : attestation),
      context.verifier,
    )).toThrow("journey_attestation_cell_lineage_digest_mismatch");
  });
});

const EXACT_MATRIX_DRIFT_CASES: readonly (readonly [
  string,
  (matrix: JourneyReleaseMatrix) => JourneyReleaseMatrix,
])[] = [
  ["an extra cell", (matrix) => {
    const source = matrix.cells[0]!;
    return {
      ...matrix,
      cells: [...matrix.cells, {
        ...source,
        bundleCellId: "cell_extra",
        scenarioId: "scenario_extra",
        lineage: { runtimeInstanceId: "runtime_instance_extra" },
      }],
    };
  }],
  ["cell order drift", (matrix) => ({
    ...matrix,
    cells: [matrix.cells[1]!, matrix.cells[0]!, ...matrix.cells.slice(2)],
  })],
  ["bundle cell ID drift", (matrix) => replaceCell(matrix, 1, {
    ...matrix.cells[1]!,
    bundleCellId: "cell_bridge-fake-j08-renamed",
  })],
  ["scenario ID drift", (matrix) => replaceCell(matrix, 1, {
    ...matrix.cells[1]!,
    scenarioId: "scenario_bridge-fake-j08-unknown-drift",
  })],
  ["stream requirement drift", (matrix) => {
    const source = matrix.cells[0]!;
    return replaceCell(matrix, 0, {
      ...source,
      streamRequirements: source.streamRequirements.map((requirement, index) => index === 0
        ? { ...requirement, checkpoints: requirement.checkpoints.slice(1) }
        : requirement),
    });
  }],
];

function requiredMatrix(): JourneyReleaseMatrix {
  const release = createFreshReleaseIdentity({ source: "source", build: "build", schema: "schema", providerPolicy: "provider-policy", policy: "policy" });
  return createRequiredJourneyReleaseMatrix(release);
}

function replaceCell(
  matrix: JourneyReleaseMatrix,
  index: number,
  cell: JourneyReleaseCellDeclaration,
): JourneyReleaseMatrix {
  return {
    ...matrix,
    cells: matrix.cells.map((candidate, candidateIndex) => candidateIndex === index ? cell : candidate),
  };
}

function oneCellMatrix(required: boolean): JourneyReleaseMatrix {
  const base = requiredMatrix();
  const lineage: JourneyEvidenceLineage = { runtimeInstanceId: "runtime_instance_optional" };
  return {
    releaseRunId: base.releaseRunId,
    nonce: base.nonce,
    digests: base.digests,
    cells: [{
      bundleCellId: "cell_optional",
      scenarioId: "scenario_optional",
      lineage,
      required,
      streamRequirements: [{
        issuer: "runtime_host",
        evidenceClass: "deterministic_fake",
        surface: "runtime-host",
        checkpoints: ["J-04"],
      }],
    }],
  };
}

function issueAllPass(matrix: JourneyReleaseMatrix, context: RunnerOwnedEvidenceContext): readonly TrustedJourneyAttestation[] {
  return matrix.cells.flatMap((cell) => cell.streamRequirements.map((requirement) =>
    issuerFor(context, requirement).issue(issueInput(cell, requirement))));
}

function issuerFor(context: RunnerOwnedEvidenceContext, requirement: JourneyStreamRequirement): RunnerOwnedEvidenceIssuer {
  switch (requirement.issuer) {
    case "runtime_host": return context.runtimeHost;
    case "browser_ui_driver": return context.browser;
    case "electron_ui_driver": return context.electron;
    case "opencode_acp_task_attestor": return context.openCodeAcpTask;
    case "codex_acp_task_attestor": return context.codexAcpTask;
    case "acp_meta_attestor": return context.acpMeta;
    default: throw new Error(`unexpected issuer ${requirement.issuer}`);
  }
}

function taskAcpStreams(
  matrix: JourneyReleaseMatrix,
  bundleCellId: "cell_opencode-acp-task" | "cell_codex-acp-task",
  providerIssuer: "opencode_acp_task_attestor" | "codex_acp_task_attestor",
): readonly JourneyStreamRequirement[] | undefined {
  const requirements = matrix.cells.find((cell) => cell.bundleCellId === bundleCellId)?.streamRequirements;
  expect(requirements?.some(({ issuer }) => issuer === providerIssuer)).toBe(true);
  return requirements;
}

function expectedTaskAcpStreams(
  providerIssuer: "opencode_acp_task_attestor" | "codex_acp_task_attestor",
): readonly JourneyStreamRequirement[] {
  const providerCheckpoints = ["J-04", "J-05", "J-06", "J-07", "J-08", "J-09", "J-10", "J-11", "J-12"] as const;
  return [
    {
      issuer: "browser_ui_driver",
      evidenceClass: "browser_rendered",
      surface: "browser",
      checkpoints: ["J-04", "J-05", "J-06", "J-12"],
    },
    {
      issuer: "electron_ui_driver",
      evidenceClass: "electron_ipc",
      surface: "desktop",
      checkpoints: ["J-07", "J-08", "J-09", "J-10", "J-11", "J-12"],
    },
    {
      issuer: "runtime_host",
      evidenceClass: "deterministic_fake",
      surface: "runtime-host",
      checkpoints: providerCheckpoints,
    },
    {
      issuer: providerIssuer,
      evidenceClass: "qualified_acp_provider",
      surface: "provider",
      checkpoints: providerCheckpoints,
    },
  ];
}

function issueInput(
  cell: JourneyReleaseCellDeclaration,
  requirement: JourneyStreamRequirement,
  outcome: JourneyOutcome = "PASS",
): JourneyAttestationIssueInput {
  const ui = requirement.issuer === "browser_ui_driver" || requirement.issuer === "electron_ui_driver";
  const actionTraces = ui ? traces(cell, requirement.issuer, requirement.checkpoints) : [];
  const actionCorrelations = ui ? correlations(cell, requirement.issuer, actionTraces) : [];
  return {
    journeyId: `journey_${cell.bundleCellId.slice("cell_".length)}`,
    bundleCellId: cell.bundleCellId,
    scenarioId: cell.scenarioId,
    outcome,
    checkpoints: outcome === "PASS" ? requirement.checkpoints : [],
    manifestDigest: DIGEST,
    ledgerChecksum: DIGEST,
    observedLineageDigest: `sha256:${createHash("sha256")
      .update(`${cell.bundleCellId}\0${cell.scenarioId}`)
      .digest("hex")}`,
    actionTraces,
    actionCorrelations,
    issuedAt: "2026-08-11T00:00:00.000Z",
  };
}

function traces(
  cell: JourneyReleaseCellDeclaration,
  issuer: JourneyStreamRequirement["issuer"],
  checkpoints: readonly FullJourneyCheckpoint[],
): readonly JourneyActionTrace[] {
  const suffix = issuer.replaceAll("_", "-");
  return checkpoints.map((checkpoint, index) => ({
    actionTraceId: `action_trace_${cell.bundleCellId.slice("cell_".length)}-${suffix}-${index + 1}`,
    scenarioId: cell.scenarioId,
    checkpoint,
    intentKind: `task.visible-mutation-${index + 1}`,
    action: "click",
    target: { by: "testId", value: `control-${index + 1}` },
    expectedHostCommands: 1,
  }));
}

function correlations(
  cell: JourneyReleaseCellDeclaration,
  issuer: JourneyStreamRequirement["issuer"],
  actionTraces: readonly JourneyActionTrace[],
): readonly ActionCommandCorrelation[] {
  const suffix = issuer.replaceAll("_", "-");
  return actionTraces.map((trace, index) => ({
    actionTraceId: trace.actionTraceId,
    scenarioId: trace.scenarioId,
    checkpoint: trace.checkpoint,
    intentKind: trace.intentKind,
    uiIntentId: `ui_intent_${cell.bundleCellId.slice("cell_".length)}-${suffix}-${index + 1}`,
    commandId: `command_${cell.bundleCellId.slice("cell_".length)}-${suffix}-${index + 1}`,
    runtimeInstanceId: cell.lineage.runtimeInstanceId,
  }));
}
