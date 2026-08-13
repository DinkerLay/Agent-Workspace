import { describe, expect, it } from "vitest";
import {
  validateAcpReleaseAttestationDocument,
  type AcpReleaseAttestationExpectation,
  type AcpReleaseAttestorIssuer,
  type AcpReleaseProductionObservation,
} from "./acp-release-attestation.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const TASK_ROLES = ["conductor", "publisher", "worker", "reviewer"] as const;

describe("ACP release attestation authority v2", () => {
  it.each([
    ["opencode_acp_task_attestor", "cell_opencode-acp-task", TASK_ROLES, [1, 2]],
    ["codex_acp_task_attestor", "cell_codex-acp-task", TASK_ROLES, [1, 2]],
    ["acp_meta_attestor", "cell_acp-meta", ["meta"], [1]],
  ] as const)("accepts only complete finalized Host generations for %s", (
    issuer,
    cellId,
    roles,
    hostGenerations,
  ) => {
    const document = validDocument(issuer, cellId, roles, hostGenerations);
    expect(validateAcpReleaseAttestationDocument(
      document,
      expectation(issuer, cellId, hostGenerations),
    )).toMatchObject({
      schemaVersion: 2,
      issuer,
      finalizedHostGeneration: hostGenerations.at(-1),
      generations: hostGenerations.map((hostGeneration) => ({
        hostGeneration,
        productionObservations: roles.map((role) => ({ role })),
      })),
    });
  });

  it("allows the same profile and behavior-probe digest after a fresh Host generation", () => {
    const document = validDocument(
      "opencode_acp_task_attestor",
      "cell_opencode-acp-task",
      TASK_ROLES,
      [1, 2],
    );
    expect(document.generations[1]!.productionObservations.map(({ profileRevisionId }) => profileRevisionId))
      .toEqual(document.generations[0]!.productionObservations.map(({ profileRevisionId }) => profileRevisionId));
    expect(document.generations[1]!.productionObservations.map(({ qualificationProbeDigest }) => qualificationProbeDigest))
      .toEqual(document.generations[0]!.productionObservations.map(({ qualificationProbeDigest }) => qualificationProbeDigest));
    expect(() => validateAcpReleaseAttestationDocument(
      document,
      expectation("opencode_acp_task_attestor", "cell_opencode-acp-task", [1, 2]),
    )).not.toThrow();
  });

  it("rejects profile or behavior-probe reuse inside one Host generation", () => {
    const document = validDocument(
      "opencode_acp_task_attestor",
      "cell_opencode-acp-task",
      TASK_ROLES,
      [1, 2],
    );
    for (const field of ["profileRevisionId", "qualificationProbeDigest"] as const) {
      expect(() => validateAcpReleaseAttestationDocument({
        ...document,
        generations: [{
          ...document.generations[0],
          productionObservations: document.generations[0]!.productionObservations.map((observation, index) => (
            index === 1
              ? { ...observation, [field]: document.generations[0]!.productionObservations[0]![field] }
              : observation
          )),
          semanticFacts: field === "profileRevisionId"
            ? document.generations[0]!.semanticFacts.map((fact) => (
                fact.profileRevisionId === document.generations[0]!.productionObservations[1]!.profileRevisionId
                  ? {
                      ...fact,
                      profileRevisionId: document.generations[0]!.productionObservations[0]!.profileRevisionId,
                    }
                  : fact
              ))
            : document.generations[0]!.semanticFacts,
        }, document.generations[1]],
      }, expectation("opencode_acp_task_attestor", "cell_opencode-acp-task", [1, 2])))
        .toThrow("journey_acp_attestation_profile_observation_reused");
    }
  });

  it.each([
    "qualificationDigest",
    "processGenerationDigest",
    "productionReceiptDigest",
  ] as const)("rejects %s reuse anywhere in the document", (field) => {
    const document = validDocument(
      "codex_acp_task_attestor",
      "cell_codex-acp-task",
      TASK_ROLES,
      [1, 2],
    );
    const reused = document.generations[0]!.productionObservations[0]![field];
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      generations: [
        document.generations[0],
        {
          ...document.generations[1],
          productionObservations: document.generations[1]!.productionObservations.map((observation, index) => (
            index === 0 ? { ...observation, [field]: reused } : observation
          )),
          semanticFacts: field === "processGenerationDigest"
            ? document.generations[1]!.semanticFacts.map((fact) => (
                fact.processGenerationDigest
                  === document.generations[1]!.productionObservations[0]!.processGenerationDigest
                  ? { ...fact, processGenerationDigest: reused }
                  : fact
              ))
            : document.generations[1]!.semanticFacts,
        },
      ],
    }, expectation("codex_acp_task_attestor", "cell_codex-acp-task", [1, 2])))
      .toThrow("journey_acp_attestation_profile_observation_reused");
  });

  it("rejects a fact joined to the same profile in the wrong Host generation", () => {
    const document = validDocument(
      "opencode_acp_task_attestor",
      "cell_opencode-acp-task",
      TASK_ROLES,
      [1, 2],
    );
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      generations: [
        document.generations[0],
        {
          ...document.generations[1],
          semanticFacts: document.generations[1]!.semanticFacts.map((fact, index) => index === 0
            ? {
                ...fact,
                processGenerationDigest:
                  document.generations[0]!.productionObservations[0]!.processGenerationDigest,
              }
            : fact),
        },
      ],
    }, expectation("opencode_acp_task_attestor", "cell_opencode-acp-task", [1, 2])))
      .toThrow("journey_acp_attestation_fact_invalid");
  });

  it("rejects missing, reordered, non-contiguous, or inferred final Host generations", () => {
    const document = validDocument(
      "opencode_acp_task_attestor",
      "cell_opencode-acp-task",
      TASK_ROLES,
      [1, 2],
    );
    const expected = expectation("opencode_acp_task_attestor", "cell_opencode-acp-task", [1, 2]);
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      finalizedHostGeneration: 1,
      generations: document.generations.slice(0, 1),
    }, expected)).toThrow("journey_acp_attestation_host_generations_invalid");
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      generations: [...document.generations].reverse(),
    }, expected)).toThrow("journey_acp_attestation_host_generations_invalid");
    expect(() => validateAcpReleaseAttestationDocument(document, {
      ...expected,
      expectedHostGenerations: [1, 3],
    })).toThrow("journey_acp_attestation_expectation_invalid");
  });

  it("requires the final persisted generation lineage to equal the parent expectation", () => {
    const document = validDocument(
      "opencode_acp_task_attestor",
      "cell_opencode-acp-task",
      TASK_ROLES,
      [1, 2],
    );
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      generations: document.generations.map((generation, index) => index === 1
        ? { ...generation, observedLineageDigest: digest(901) }
        : generation),
    }, expectation("opencode_acp_task_attestor", "cell_opencode-acp-task", [1, 2])))
      .toThrow("journey_acp_attestation_final_lineage_invalid");
  });

  it("rejects incomplete role, semantic, prompt, and cleanup evidence inside each generation", () => {
    const document = validDocument("acp_meta_attestor", "cell_acp-meta", ["meta"], [1]);
    const expected = expectation("acp_meta_attestor", "cell_acp-meta", [1]);
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      generations: [{
        ...document.generations[0],
        productionObservations: [{
          ...document.generations[0]!.productionObservations[0],
          actualPrompt: {
            ...document.generations[0]!.productionObservations[0]!.actualPrompt,
            terminalObserved: false,
          },
        }],
      }],
    }, expected)).toThrow("journey_acp_attestation_prompt_lifecycle_invalid");
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      generations: [{
        ...document.generations[0],
        productionObservations: [{
          ...document.generations[0]!.productionObservations[0],
          cleanup: {
            ...document.generations[0]!.productionObservations[0]!.cleanup,
            processExitConfirmed: false,
          },
        }],
      }],
    }, expected)).toThrow("journey_acp_attestation_cleanup_invalid");
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      generations: [{
        ...document.generations[0],
        semanticFacts: document.generations[0]!.semanticFacts.filter(({ kind }) => kind !== "permission_rejected"),
      }],
    }, expected)).toThrow("journey_acp_attestation_fact_coverage_invalid");
  });

  it("rejects globally reused fact digests, J-labels, open payloads, and raw/private fields", () => {
    const document = validDocument(
      "opencode_acp_task_attestor",
      "cell_opencode-acp-task",
      TASK_ROLES,
      [1, 2],
    );
    const expected = expectation("opencode_acp_task_attestor", "cell_opencode-acp-task", [1, 2]);
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      generations: document.generations.map((generation, generationIndex) => ({
        ...generation,
        semanticFacts: generation.semanticFacts.map((fact, factIndex) => generationIndex === 1 && factIndex === 0
          ? { ...fact, observationDigest: document.generations[0]!.semanticFacts[0]!.observationDigest }
          : fact),
      })),
    }, expected)).toThrow("journey_acp_attestation_fact_reused");
    for (const injected of [{ checkpoint: "J-04" }, { event: "verified_fact" }]) {
      expect(() => validateAcpReleaseAttestationDocument({
        ...document,
        generations: [{
          ...document.generations[0],
          semanticFacts: [{ ...document.generations[0]!.semanticFacts[0], ...injected },
            ...document.generations[0]!.semanticFacts.slice(1)],
        }, document.generations[1]],
      }, expected)).toThrow("journey_acp_attestation_fact_invalid");
    }
    expect(() => validateAcpReleaseAttestationDocument({
      ...document,
      rawSessionId: "/private/raw-session-must-not-survive",
    }, expected)).toThrow();
  });
});

function expectation(
  issuer: AcpReleaseAttestorIssuer,
  bundleCellId: string,
  expectedHostGenerations: readonly number[],
): AcpReleaseAttestationExpectation {
  return {
    releaseRunId: "release_acp-test",
    nonce: "nonce_acp-test-000000000000",
    bundleCellId,
    scenarioId: bundleCellId.replace("cell_", "scenario_"),
    runtimeInstanceId: `runtime_instance_${bundleCellId.slice(5)}`,
    observedLineageDigest: DIGEST,
    issuer,
    expectedHostGenerations,
  };
}

function validDocument(
  issuer: AcpReleaseAttestorIssuer,
  bundleCellId: string,
  roles: readonly AcpReleaseProductionObservation["role"][],
  hostGenerations: readonly number[],
) {
  const expected = expectation(issuer, bundleCellId, hostGenerations);
  return {
    schemaVersion: 2,
    issuer,
    releaseRunId: expected.releaseRunId,
    nonce: expected.nonce,
    bundleCellId,
    scenarioId: expected.scenarioId,
    runtimeInstanceId: expected.runtimeInstanceId,
    finalizedHostGeneration: hostGenerations.at(-1),
    generations: hostGenerations.map((hostGeneration, generationIndex) => {
      const productionObservations = roles.map((role, roleIndex) => productionObservation(
        issuer,
        role,
        hostGeneration,
        roleIndex,
      ));
      return {
        hostGeneration,
        observedLineageDigest: generationIndex === hostGenerations.length - 1
          ? DIGEST
          : digest(800 + generationIndex),
        semanticFacts: semanticFacts(issuer, productionObservations, hostGeneration),
        productionObservations,
      };
    }),
  } as const;
}

function semanticFacts(
  issuer: AcpReleaseAttestorIssuer,
  observations: readonly AcpReleaseProductionObservation[],
  hostGeneration: number,
) {
  let sequence = hostGeneration * 100;
  const fact = (
    kind: string,
    observation: AcpReleaseProductionObservation,
  ) => ({
    kind,
    profileRevisionId: observation.profileRevisionId,
    processGenerationDigest: observation.processGenerationDigest,
    observationDigest: digest(sequence++),
  });
  if (issuer === "acp_meta_attestor") {
    const observation = observations[0]!;
    return [
      fact("independent_process", observation),
      fact("no_tools", observation),
      fact("no_cwd", observation),
      fact("no_workspace", observation),
      fact("strict_whole_final", observation),
      fact("permission_rejected", observation),
      fact("cold_reconcile", observation),
    ];
  }
  const facts = observations.flatMap((observation) => [
    fact("actual_binding_generation", observation),
    fact("prompt_receipt", observation),
    fact("latest_final_terminal_pair", observation),
    fact("restart_load_resume", observation),
  ]);
  const conductor = observations.find(({ role }) => role === "conductor")!;
  const publisher = observations.find(({ role }) => role === "publisher")!;
  facts.push(
    fact("cancel_reconcile", conductor),
    fact("scoped_mcp_call", conductor),
    fact("scoped_mcp_call", publisher),
  );
  return facts;
}

function productionObservation(
  issuer: AcpReleaseAttestorIssuer,
  role: AcpReleaseProductionObservation["role"],
  hostGeneration: number,
  roleIndex: number,
): AcpReleaseProductionObservation {
  const providerFamily = issuer === "codex_acp_task_attestor" ? "codex" : "opencode";
  const acpAgentKind = providerFamily === "codex" ? "codex_acp" : "native_acp";
  const unique = hostGeneration * 100 + roleIndex * 10;
  return {
    schemaVersion: 1,
    evidenceClass: issuer === "acp_meta_attestor" ? "qualified_acp_meta" : "qualified_acp_provider",
    productionLane: issuer,
    profileRevisionId: `profile_revision_${issuer}-${role}`,
    providerFamily,
    acpAgentKind,
    role,
    model: `${providerFamily}-current/model-${role}`,
    profileConfigurationDigest: digest(roleIndex + 1),
    resolutionSealDigest: digest(unique + 1),
    observedArtifactVersion: "current-observed-version",
    processGenerationDigest: digest(unique + 2),
    qualificationDigest: digest(unique + 3),
    initialize: {
      protocolMajor: 1,
      agent: { name: `${providerFamily}-acp`, version: "current" },
      capabilities: ["session/create", "session/prompt"],
      extensions: [],
      capabilityFingerprint: digest(unique + 4),
    },
    // The same behavioral qualification result may recur after a clean restart.
    qualificationProbeDigest: digest(roleIndex + 20),
    actualPrompt: {
      receiptObserved: true,
      finalObserved: true,
      terminalObserved: true,
      attemptCorrelationDigest: digest(unique + 5),
      lifecycleDigest: digest(unique + 6),
    },
    cleanup: {
      bindingReleaseConfirmed: true,
      processExitConfirmed: true,
      credentialCleanupConfirmed: true,
      capabilityCleanupConfirmed: true,
      receiptDigest: digest(unique + 7),
    },
    productionReceiptDigest: digest(unique + 8),
  };
}

function digest(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
