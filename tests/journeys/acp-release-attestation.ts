import { assertEvidenceSafe, type JourneyEvidenceIssuer } from "../e2e/journey-evidence.js";

export type AcpReleaseAttestorIssuer = Extract<
  JourneyEvidenceIssuer,
  "opencode_acp_task_attestor" | "codex_acp_task_attestor" | "acp_meta_attestor"
>;

export type AcpReleaseProductionObservation = Readonly<{
  schemaVersion: 1;
  evidenceClass: "qualified_acp_provider" | "qualified_acp_meta";
  productionLane: AcpReleaseAttestorIssuer;
  profileRevisionId: string;
  providerFamily: "opencode" | "codex";
  acpAgentKind: "native_acp" | "codex_acp";
  role: "conductor" | "publisher" | "worker" | "reviewer" | "meta";
  model: string;
  profileConfigurationDigest: string;
  resolutionSealDigest: string;
  observedArtifactVersion: string;
  observedUpstreamVersion?: string;
  /** Host-issued opaque qualification identity for this exact process generation. */
  qualificationDigest: string;
  processGenerationDigest: string;
  initialize: Readonly<{
    protocolMajor: 1;
    agent?: Readonly<{
      name: string;
      title?: string;
      version?: string;
    }>;
    capabilities: readonly string[];
    extensions: readonly string[];
    capabilityFingerprint: string;
  }>;
  /** Behavior may deterministically recur; it is not a generation identity. */
  qualificationProbeDigest: string;
  actualPrompt: Readonly<{
    receiptObserved: true;
    finalObserved: true;
    terminalObserved: true;
    attemptCorrelationDigest: string;
    lifecycleDigest: string;
  }>;
  cleanup: Readonly<{
    bindingReleaseConfirmed: true;
    processExitConfirmed: true;
    credentialCleanupConfirmed: true;
    capabilityCleanupConfirmed: true;
    receiptDigest: string;
  }>;
  productionReceiptDigest: string;
}>;

export type AcpTaskReleaseFactKind =
  | "actual_binding_generation"
  | "prompt_receipt"
  | "latest_final_terminal_pair"
  | "cancel_reconcile"
  | "restart_load_resume"
  | "scoped_mcp_call";

export type AcpMetaReleaseFactKind =
  | "independent_process"
  | "no_tools"
  | "no_cwd"
  | "no_workspace"
  | "strict_whole_final"
  | "permission_rejected"
  | "cold_reconcile";

export type AcpReleaseSemanticFact = Readonly<{
  kind: AcpTaskReleaseFactKind | AcpMetaReleaseFactKind;
  profileRevisionId: string;
  processGenerationDigest: string;
  observationDigest: string;
}>;

export type AcpReleaseAttestationGeneration = Readonly<{
  hostGeneration: number;
  observedLineageDigest: string;
  semanticFacts: readonly AcpReleaseSemanticFact[];
  productionObservations: readonly AcpReleaseProductionObservation[];
}>;

/** Closed generation-aware release evidence. Schema v1 is intentionally not accepted. */
export type AcpReleaseAttestationDocument = Readonly<{
  schemaVersion: 2;
  issuer: AcpReleaseAttestorIssuer;
  releaseRunId: string;
  nonce: string;
  bundleCellId: string;
  scenarioId: string;
  runtimeInstanceId: string;
  finalizedHostGeneration: number;
  generations: readonly AcpReleaseAttestationGeneration[];
}>;

export type AcpReleaseAttestationExpectation = Readonly<{
  releaseRunId: string;
  nonce: string;
  bundleCellId: string;
  scenarioId: string;
  runtimeInstanceId: string;
  /** Canonical lineage of the exact final, cleanup-confirmed Host generation. */
  observedLineageDigest: string;
  issuer: AcpReleaseAttestorIssuer;
  /** Parent/matrix authority; never inferred from an attestation document. */
  expectedHostGenerations: readonly number[];
}>;

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const PROFILE_REVISION_ID = /^profile_revision_[A-Za-z0-9_-]{1,223}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:@+-]*)?$/u;
const SAFE_VERSION = /^[^\s\u0000-\u001f\u007f]{1,160}$/u;
const TASK_ROLES = Object.freeze(["conductor", "publisher", "worker", "reviewer"] as const);
const TASK_FACT_KINDS = Object.freeze([
  "actual_binding_generation",
  "prompt_receipt",
  "latest_final_terminal_pair",
  "cancel_reconcile",
  "restart_load_resume",
  "scoped_mcp_call",
] as const satisfies readonly AcpTaskReleaseFactKind[]);
const META_FACT_KINDS = Object.freeze([
  "independent_process",
  "no_tools",
  "no_cwd",
  "no_workspace",
  "strict_whole_final",
  "permission_rejected",
  "cold_reconcile",
] as const satisfies readonly AcpMetaReleaseFactKind[]);
const TASK_PER_PROFILE_FACT_KINDS = Object.freeze([
  "actual_binding_generation",
  "prompt_receipt",
  "latest_final_terminal_pair",
  "restart_load_resume",
] as const satisfies readonly AcpTaskReleaseFactKind[]);
const FACT_KEYS = Object.freeze([
  "kind",
  "profileRevisionId",
  "processGenerationDigest",
  "observationDigest",
]);
const DOCUMENT_KEYS = Object.freeze([
  "schemaVersion",
  "issuer",
  "releaseRunId",
  "nonce",
  "bundleCellId",
  "scenarioId",
  "runtimeInstanceId",
  "finalizedHostGeneration",
  "generations",
]);
const GENERATION_KEYS = Object.freeze([
  "hostGeneration",
  "observedLineageDigest",
  "semanticFacts",
  "productionObservations",
]);
const OBSERVATION_KEYS = Object.freeze([
  "schemaVersion",
  "evidenceClass",
  "productionLane",
  "profileRevisionId",
  "providerFamily",
  "acpAgentKind",
  "role",
  "model",
  "profileConfigurationDigest",
  "resolutionSealDigest",
  "observedArtifactVersion",
  "observedUpstreamVersion",
  "qualificationDigest",
  "processGenerationDigest",
  "initialize",
  "qualificationProbeDigest",
  "actualPrompt",
  "cleanup",
  "productionReceiptDigest",
]);

export function isAcpReleaseAttestorIssuer(value: JourneyEvidenceIssuer): value is AcpReleaseAttestorIssuer {
  return value === "opencode_acp_task_attestor"
    || value === "codex_acp_task_attestor"
    || value === "acp_meta_attestor";
}

export function validateAcpReleaseAttestationDocument(
  value: unknown,
  expected: AcpReleaseAttestationExpectation,
): AcpReleaseAttestationDocument {
  assertExpectation(expected);
  assertEvidenceSafe(value);
  if (!isRecord(value)
    || !sameKeys(value, DOCUMENT_KEYS)
    || value.schemaVersion !== 2
    || value.issuer !== expected.issuer
    || value.releaseRunId !== expected.releaseRunId
    || value.nonce !== expected.nonce
    || value.bundleCellId !== expected.bundleCellId
    || value.scenarioId !== expected.scenarioId
    || value.runtimeInstanceId !== expected.runtimeInstanceId
    || !Array.isArray(value.generations)) {
    throw new Error("journey_acp_attestation_identity_invalid");
  }
  const observedHostGenerations = value.generations.map((entry) => isRecord(entry)
    ? entry.hostGeneration
    : undefined);
  if (value.finalizedHostGeneration !== expected.expectedHostGenerations.at(-1)
    || observedHostGenerations.length !== expected.expectedHostGenerations.length
    || observedHostGenerations.some((entry, index) => entry !== expected.expectedHostGenerations[index])) {
    throw new Error("journey_acp_attestation_host_generations_invalid");
  }

  const allObservations: AcpReleaseProductionObservation[] = [];
  const allFactDigests = new Set<string>();
  const generations = value.generations.map((entry, index) => {
    const generation = validateAcpReleaseAttestationGeneration(
      entry,
      expected.issuer,
      expected.expectedHostGenerations[index]!,
    );
    for (const observation of generation.productionObservations) allObservations.push(observation);
    for (const fact of generation.semanticFacts) {
      if (allFactDigests.has(fact.observationDigest)) {
        throw new Error("journey_acp_attestation_fact_reused");
      }
      allFactDigests.add(fact.observationDigest);
    }
    return generation;
  });
  assertNoProductionObservationReuse(allObservations);
  if (generations.at(-1)?.observedLineageDigest !== expected.observedLineageDigest) {
    throw new Error("journey_acp_attestation_final_lineage_invalid");
  }
  return Object.freeze({
    schemaVersion: 2,
    issuer: expected.issuer,
    releaseRunId: expected.releaseRunId,
    nonce: expected.nonce,
    bundleCellId: expected.bundleCellId,
    scenarioId: expected.scenarioId,
    runtimeInstanceId: expected.runtimeInstanceId,
    finalizedHostGeneration: value.finalizedHostGeneration as number,
    generations: Object.freeze(generations),
  });
}

function assertExpectation(value: AcpReleaseAttestationExpectation): void {
  if (!isRecord(value)
    || !SHA256.test(asString(value.observedLineageDigest))
    || !Array.isArray(value.expectedHostGenerations)
    || value.expectedHostGenerations.length === 0
    || value.expectedHostGenerations.some((entry, index) => (
      !Number.isSafeInteger(entry) || entry !== index + 1
    ))) {
    throw new Error("journey_acp_attestation_expectation_invalid");
  }
}

export function validateAcpReleaseAttestationGeneration(
  value: unknown,
  issuer: AcpReleaseAttestorIssuer,
  expectedHostGeneration: number,
): AcpReleaseAttestationGeneration {
  if (!isRecord(value)
    || !sameKeys(value, GENERATION_KEYS)
    || value.hostGeneration !== expectedHostGeneration
    || !SHA256.test(asString(value.observedLineageDigest))
    || !Array.isArray(value.semanticFacts)
    || !Array.isArray(value.productionObservations)) {
    throw new Error("journey_acp_attestation_generation_invalid");
  }
  const observations = value.productionObservations.map((entry) =>
    validateAcpReleaseProductionObservation(entry, issuer));
  const expectedRoles: readonly AcpReleaseProductionObservation["role"][] = issuer === "acp_meta_attestor"
    ? ["meta"]
    : TASK_ROLES;
  const observedRoles = observations.map(({ role }) => role);
  const observedProfiles = observations.map(({ profileRevisionId }) => profileRevisionId);
  const observedBehaviorProbes = observations.map(({ qualificationProbeDigest }) => qualificationProbeDigest);
  if (observedRoles.length !== expectedRoles.length
    || new Set(observedRoles).size !== observedRoles.length
    || expectedRoles.some((role) => !observedRoles.includes(role))) {
    throw new Error("journey_acp_attestation_role_coverage_invalid");
  }
  if (new Set(observedProfiles).size !== observedProfiles.length
    || new Set(observedBehaviorProbes).size !== observedBehaviorProbes.length) {
    throw new Error("journey_acp_attestation_profile_observation_reused");
  }
  const semanticFacts = validateSemanticFacts(value.semanticFacts, issuer, observations);
  return Object.freeze({
    hostGeneration: expectedHostGeneration,
    observedLineageDigest: value.observedLineageDigest as string,
    semanticFacts,
    productionObservations: Object.freeze(observations),
  });
}

function validateSemanticFacts(
  values: readonly unknown[],
  issuer: AcpReleaseAttestorIssuer,
  observations: readonly AcpReleaseProductionObservation[],
): readonly AcpReleaseSemanticFact[] {
  const metaLane = issuer === "acp_meta_attestor";
  const allowedKinds: readonly (AcpTaskReleaseFactKind | AcpMetaReleaseFactKind)[] = metaLane
    ? META_FACT_KINDS
    : TASK_FACT_KINDS;
  const facts = values.map((value): AcpReleaseSemanticFact => {
    if (!isRecord(value)
      || !sameKeys(value, FACT_KEYS)
      || !allowedKinds.includes(value.kind as AcpTaskReleaseFactKind | AcpMetaReleaseFactKind)
      || !PROFILE_REVISION_ID.test(asString(value.profileRevisionId))
      || !SHA256.test(asString(value.processGenerationDigest))
      || !SHA256.test(asString(value.observationDigest))) {
      throw new Error("journey_acp_attestation_fact_invalid");
    }
    const observation = observations.find((candidate) => (
      candidate.profileRevisionId === value.profileRevisionId
      && candidate.processGenerationDigest === value.processGenerationDigest
    ));
    if (!observation) throw new Error("journey_acp_attestation_fact_invalid");
    if (value.kind === "scoped_mcp_call"
      && observation.role !== "conductor"
      && observation.role !== "publisher") {
      throw new Error("journey_acp_attestation_fact_lane_mismatch");
    }
    return Object.freeze({
      kind: value.kind as AcpTaskReleaseFactKind | AcpMetaReleaseFactKind,
      profileRevisionId: value.profileRevisionId as string,
      processGenerationDigest: value.processGenerationDigest as string,
      observationDigest: value.observationDigest as string,
    });
  });
  const factIdentities = facts.map((fact) => (
    `${fact.kind}|${fact.profileRevisionId}|${fact.processGenerationDigest}`
  ));
  if (new Set(factIdentities).size !== factIdentities.length
    || new Set(facts.map(({ observationDigest }) => observationDigest)).size !== facts.length) {
    throw new Error("journey_acp_attestation_fact_reused");
  }
  if (metaLane) {
    const observation = observations[0]!;
    if (META_FACT_KINDS.some((kind) => !hasFact(facts, observation, kind))) {
      throw new Error("journey_acp_attestation_fact_coverage_invalid");
    }
  } else {
    for (const observation of observations) {
      if (TASK_PER_PROFILE_FACT_KINDS.some((kind) => !hasFact(facts, observation, kind))) {
        throw new Error("journey_acp_attestation_fact_coverage_invalid");
      }
    }
    if (!facts.some(({ kind }) => kind === "cancel_reconcile")) {
      throw new Error("journey_acp_attestation_fact_coverage_invalid");
    }
    for (const role of ["conductor", "publisher"] as const) {
      const observation = observations.find((candidate) => candidate.role === role)!;
      if (!hasFact(facts, observation, "scoped_mcp_call")) {
        throw new Error("journey_acp_attestation_fact_coverage_invalid");
      }
    }
  }
  return Object.freeze(facts);
}

function hasFact(
  facts: readonly AcpReleaseSemanticFact[],
  observation: AcpReleaseProductionObservation,
  kind: AcpTaskReleaseFactKind | AcpMetaReleaseFactKind,
): boolean {
  return facts.some((fact) => fact.kind === kind
    && fact.profileRevisionId === observation.profileRevisionId
    && fact.processGenerationDigest === observation.processGenerationDigest);
}

function assertNoProductionObservationReuse(
  observations: readonly AcpReleaseProductionObservation[],
): void {
  for (const field of [
    "qualificationDigest",
    "processGenerationDigest",
    "productionReceiptDigest",
  ] as const) {
    const values = observations.map((observation) => observation[field]);
    if (new Set(values).size !== values.length) {
      throw new Error("journey_acp_attestation_profile_observation_reused");
    }
  }
}

export function validateAcpReleaseProductionObservation(
  value: unknown,
  issuer: AcpReleaseAttestorIssuer,
): AcpReleaseProductionObservation {
  if (!isRecord(value)
    || !sameKeys(value, OBSERVATION_KEYS, ["observedUpstreamVersion"])
    || value.schemaVersion !== 1
    || value.productionLane !== issuer
    || !PROFILE_REVISION_ID.test(asString(value.profileRevisionId))
    || !SAFE_IDENTIFIER.test(asString(value.model))
    || !SAFE_VERSION.test(asString(value.observedArtifactVersion))
    || (value.observedUpstreamVersion !== undefined
      && !SAFE_VERSION.test(asString(value.observedUpstreamVersion)))) {
    throw new Error("journey_acp_attestation_observation_invalid");
  }
  const expected = issuer === "opencode_acp_task_attestor"
    ? { evidenceClass: "qualified_acp_provider", providerFamily: "opencode", acpAgentKind: "native_acp" }
    : issuer === "codex_acp_task_attestor"
      ? { evidenceClass: "qualified_acp_provider", providerFamily: "codex", acpAgentKind: "codex_acp" }
      : { evidenceClass: "qualified_acp_meta", providerFamily: value.providerFamily, acpAgentKind: value.acpAgentKind };
  if (value.evidenceClass !== expected.evidenceClass
    || value.providerFamily !== expected.providerFamily
    || value.acpAgentKind !== expected.acpAgentKind
    || (issuer === "acp_meta_attestor"
      ? value.role !== "meta"
        || !((value.providerFamily === "opencode" && value.acpAgentKind === "native_acp")
          || (value.providerFamily === "codex" && value.acpAgentKind === "codex_acp"))
      : !TASK_ROLES.includes(value.role as typeof TASK_ROLES[number]))) {
    throw new Error("journey_acp_attestation_lane_mismatch");
  }
  for (const field of [
    "profileConfigurationDigest",
    "resolutionSealDigest",
    "qualificationDigest",
    "processGenerationDigest",
    "qualificationProbeDigest",
    "productionReceiptDigest",
  ] as const) {
    if (!SHA256.test(asString(value[field]))) throw new Error("journey_acp_attestation_digest_invalid");
  }
  return Object.freeze({
    ...value,
    initialize: validateInitialize(value.initialize),
    actualPrompt: validateActualPrompt(value.actualPrompt),
    cleanup: validateCleanup(value.cleanup),
  }) as AcpReleaseProductionObservation;
}

function validateInitialize(value: unknown): AcpReleaseProductionObservation["initialize"] {
  const allowedKeys = ["protocolMajor", "agent", "capabilities", "extensions", "capabilityFingerprint"] as const;
  if (!isRecord(value)
    || !sameKeys(value, allowedKeys, ["agent"])
    || value.protocolMajor !== 1
    || !Array.isArray(value.capabilities)
    || !Array.isArray(value.extensions)
    || !SHA256.test(asString(value.capabilityFingerprint))
    || !safeStringArray(value.capabilities)
    || !safeStringArray(value.extensions)
    || (value.agent !== undefined && !validAgent(value.agent))) {
    throw new Error("journey_acp_attestation_initialize_invalid");
  }
  return Object.freeze({
    protocolMajor: 1,
    ...(value.agent === undefined ? {} : { agent: normalizeAgent(value.agent) }),
    capabilities: Object.freeze([...value.capabilities]) as readonly string[],
    extensions: Object.freeze([...value.extensions]) as readonly string[],
    capabilityFingerprint: value.capabilityFingerprint as string,
  });
}

function normalizeAgent(value: unknown): NonNullable<AcpReleaseProductionObservation["initialize"]["agent"]> {
  const record = value as Readonly<Record<string, unknown>>;
  return Object.freeze({
    name: record.name as string,
    ...(record.title === undefined ? {} : { title: record.title as string }),
    ...(record.version === undefined ? {} : { version: record.version as string }),
  });
}

function validateActualPrompt(value: unknown): AcpReleaseProductionObservation["actualPrompt"] {
  const keys = ["receiptObserved", "finalObserved", "terminalObserved", "attemptCorrelationDigest", "lifecycleDigest"];
  if (!isRecord(value)
    || !sameKeys(value, keys)
    || value.receiptObserved !== true
    || value.finalObserved !== true
    || value.terminalObserved !== true
    || !SHA256.test(asString(value.attemptCorrelationDigest))
    || !SHA256.test(asString(value.lifecycleDigest))) {
    throw new Error("journey_acp_attestation_prompt_lifecycle_invalid");
  }
  return Object.freeze(value) as AcpReleaseProductionObservation["actualPrompt"];
}

function validateCleanup(value: unknown): AcpReleaseProductionObservation["cleanup"] {
  const keys = [
    "bindingReleaseConfirmed",
    "processExitConfirmed",
    "credentialCleanupConfirmed",
    "capabilityCleanupConfirmed",
    "receiptDigest",
  ];
  if (!isRecord(value)
    || !sameKeys(value, keys)
    || value.bindingReleaseConfirmed !== true
    || value.processExitConfirmed !== true
    || value.credentialCleanupConfirmed !== true
    || value.capabilityCleanupConfirmed !== true
    || !SHA256.test(asString(value.receiptDigest))) {
    throw new Error("journey_acp_attestation_cleanup_invalid");
  }
  return Object.freeze(value) as AcpReleaseProductionObservation["cleanup"];
}

function validAgent(value: unknown): boolean {
  if (!isRecord(value) || !sameKeys(value, ["name", "title", "version"], ["title", "version"])) return false;
  return SAFE_VERSION.test(asString(value.name))
    && (value.title === undefined || SAFE_VERSION.test(asString(value.title)))
    && (value.version === undefined || SAFE_VERSION.test(asString(value.version)));
}

function safeStringArray(value: readonly unknown[]): value is readonly string[] {
  return value.every((entry) => typeof entry === "string" && SAFE_VERSION.test(entry))
    && new Set(value).size === value.length;
}

function sameKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const observed = Object.keys(value);
  const required = allowed.filter((key) => !optional.includes(key));
  return observed.every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
