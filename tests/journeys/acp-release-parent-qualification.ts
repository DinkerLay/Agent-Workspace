import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionProfileDefinitionV3,
  MetaProfileDefinitionV3,
  MetaProfileOptionId,
} from "@agent-workspace/runtime-contracts";
import {
  createAcpProductionHostInputs,
  parseAcpProductionConfiguration,
  RUNTIME_ACP_CONFIGURATION_ENV,
} from "../../apps/runtime-host/src/acp-production-configuration.js";
import type {
  AcpProviderAvailabilityReport,
  AcpQualificationEffect,
} from "../../apps/runtime-host/src/acp-provider-composition.js";
import { createAcpRuntimeHostPrivateAuthority } from "../../apps/runtime-host/src/acp-runtime-host-private-authority.js";
import { createSessionIdAcpProductionTaskProbePolicy } from "../../apps/runtime-host/src/session-id-acp-production-policy.js";
import {
  createAcpProductionMetaOwner,
  createCodexAcpProductionTaskNativeFactory,
  createOpenCodeAcpProductionTaskNativeFactory,
  type AcpProductionMetaOwner,
  type SessionIdAcpProductionTaskNativeFactory,
} from "../../apps/runtime-host/src/session-id-acp-production-composition.js";
import {
  claimAcpReleaseParentQualificationInputs,
  consumeAcpReleaseParentInputSealBeforeFirstEffect,
  verifyFrozenAcpReleaseParentInputSeal,
  type AcpReleaseParentInputSeal,
  type AcpReleaseParentInputSealSafeObservation,
  type AcpReleaseParentQualificationInput,
} from "./acp-release-parent-preflight.js";
import { createAcpTaskJourneyTemplateDefinition } from "./full-journey.scenario.js";
import type { AcpReleaseAttestorIssuer } from "./acp-release-attestation.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const TASK_ROLES = Object.freeze([
  "conductor",
  "publisher",
  "worker",
  "reviewer",
] as const);

type TaskRole = typeof TASK_ROLES[number];
type QualificationRole = TaskRole | "meta";
type QualificationProfile = ExecutionProfileDefinitionV3 | MetaProfileDefinitionV3;
type TaskQualificationInput = Extract<
  AcpReleaseParentQualificationInput,
  { taskWorkspaceDirectory: string }
>;
type OpenCodeQualificationInput = Readonly<Omit<TaskQualificationInput, "issuer"> & {
  issuer: "opencode_acp_task_attestor";
}>;
type CodexQualificationInput = Readonly<Omit<TaskQualificationInput, "issuer"> & {
  issuer: "codex_acp_task_attestor";
}>;
type MetaQualificationInput = Extract<
  AcpReleaseParentQualificationInput,
  { issuer: "acp_meta_attestor" }
>;

export type AcpReleaseParentQualificationSealSafeObservation = Readonly<{
  schemaVersion: 1;
  kind: "acp_release_parent_qualification_seal";
  inputDigest: string;
  qualificationDigest: string;
}>;

export type AcpReleaseParentQualificationSeal = Readonly<{
  safeObservation(): AcpReleaseParentQualificationSealSafeObservation;
  toJSON(): AcpReleaseParentQualificationSealSafeObservation;
}>;

export type AcpReleaseParentQualificationInputAuthority = Readonly<{
  consume(): Promise<AcpReleaseParentInputSealSafeObservation>;
  claim(): Promise<readonly AcpReleaseParentQualificationInput[]>;
  verify(): Promise<void>;
}>;

export type AcpReleaseParentQualificationLaneExecutor = {
  readonly issuer: AcpReleaseAttestorIssuer;
  run(input: Readonly<{
    qualificationInput: AcpReleaseParentQualificationInput;
    qualificationRoot: string;
    profile: QualificationProfile;
    role: QualificationRole;
    reserve(effect: AcpQualificationEffect): undefined;
  }>): Promise<AcpProviderAvailabilityReport>;
  close(): Promise<void>;
};

export class AcpReleaseParentQualificationBlockedError extends Error {
  constructor(
    readonly code: string,
    readonly observation?: Readonly<{
      issuer: AcpReleaseAttestorIssuer;
      profileRevisionId: string;
      role: QualificationRole;
      unavailableReasons: readonly string[];
    }>,
  ) {
    super(code);
    this.name = "AcpReleaseParentQualificationBlockedError";
  }
}

export class AcpReleaseParentQualificationCleanupError extends Error {
  readonly code = "acp_release_parent_qualification_cleanup_unconfirmed";

  constructor(
    readonly observation?: Readonly<{
      issuer: AcpReleaseAttestorIssuer;
      profileRevisionId: string;
      role: QualificationRole;
      unavailableReasons: readonly string[];
    }>,
  ) {
    super("acp_release_parent_qualification_cleanup_unconfirmed");
    this.name = "AcpReleaseParentQualificationCleanupError";
  }
}

type EffectCounts = {
  credential: number;
  process: number;
  prompt: number;
};

type NormalizedReport = Readonly<{
  issuer: AcpReleaseAttestorIssuer;
  profileRevisionId: string;
  role: QualificationRole;
  providerFamily: "opencode" | "codex";
  acpAgentKind: "native_acp" | "codex_acp";
  protocolMajor: number;
  observedArtifactVersion: string;
  observedUpstreamVersion?: string;
  capabilityFingerprint: string;
  probeFingerprint: string;
  effects: Readonly<EffectCounts>;
}>;

type SealState = Readonly<{
  inputAuthority: AcpReleaseParentQualificationInputAuthority;
  inputDigest: string;
  qualificationDigest: string;
  privateSalt: Buffer;
  reports: readonly NormalizedReport[];
  counters: Readonly<EffectCounts>;
  laneRoots: readonly string[];
}>;

const STATES = new WeakMap<object, SealState>();

/** Test-only state-machine seam. The release aggregate uses the fixed production entry below. */
export async function createAcpReleaseParentQualificationSealWithExecutorsForTest(input: Readonly<{
  inputAuthority: AcpReleaseParentQualificationInputAuthority;
  qualificationRootParent: string;
  executors: Readonly<{
    openCode: AcpReleaseParentQualificationLaneExecutor;
    codex: AcpReleaseParentQualificationLaneExecutor;
    meta: AcpReleaseParentQualificationLaneExecutor;
  }>;
}>): Promise<AcpReleaseParentQualificationSeal> {
  validateOptions(input);
  const inputObservation = await input.inputAuthority.consume();
  if (!validInputObservation(inputObservation)) {
    throw new Error("acp_release_parent_qualification_input_observation_invalid");
  }
  const qualificationInputs = validateQualificationInputs(await input.inputAuthority.claim());
  const privateSalt = randomBytes(32);
  const reports: NormalizedReport[] = [];
  const globalCounts: EffectCounts = { credential: 0, process: 0, prompt: 0 };
  const laneRoots: string[] = [];

  const lanes = Object.freeze([
    Object.freeze({
      input: qualificationInputs[0],
      executor: input.executors.openCode,
      directoryName: "opencode-acp-task",
      runs: taskRuns(qualificationInputs[0]),
      expected: Object.freeze({ credential: 2, process: 2, prompt: 2 }),
    }),
    Object.freeze({
      input: qualificationInputs[1],
      executor: input.executors.codex,
      directoryName: "codex-acp-task",
      runs: taskRuns(qualificationInputs[1]),
      expected: Object.freeze({ credential: 1, process: 1, prompt: 1 }),
    }),
    Object.freeze({
      input: qualificationInputs[2],
      executor: input.executors.meta,
      directoryName: "acp-meta",
      runs: metaRuns(qualificationInputs[2]),
      expected: Object.freeze({ credential: 2, process: 2, prompt: 1 }),
    }),
  ]);
  const root = await createFreshPrivateRoot(input.qualificationRootParent);

  for (const lane of lanes) {
    if (lane.executor.issuer !== lane.input.issuer) {
      throw new Error("acp_release_parent_qualification_lane_mismatch");
    }
    await verifyInput(input.inputAuthority);
    const laneRoot = path.join(root, lane.directoryName);
    await mkdir(laneRoot, { mode: 0o700 });
    laneRoots.push(laneRoot);
    let primaryError: unknown;
    try {
      for (const run of lane.runs) {
        const counts: EffectCounts = { credential: 0, process: 0, prompt: 0 };
        const reserve = qualificationReservation(
          run.profile.profileRevisionId,
          run.role,
          counts,
          globalCounts,
        );
        const report = await lane.executor.run(Object.freeze({
          qualificationInput: lane.input,
          qualificationRoot: laneRoot,
          profile: run.profile,
          role: run.role,
          reserve,
        }));
        assertReportScope(lane.input.issuer, run.profile, run.role, report);
        if (report.available) assertExactCounts(counts, lane.expected);
        else assertCountsWithin(counts, lane.expected);
        reports.push(normalizeAvailableReport(lane.input.issuer, run.profile, run.role, report, counts));
        await verifyInput(input.inputAuthority);
      }
    } catch (error) {
      primaryError = error;
    }

    let cleanupError: unknown;
    try {
      await lane.executor.close();
      if (!isCleanupUnconfirmed(primaryError)) {
        await rm(laneRoot, { recursive: true });
        await assertAbsent(laneRoot);
      }
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new AcpReleaseParentQualificationCleanupError();
    }
    if (isCleanupUnconfirmed(primaryError)) {
      throw primaryError instanceof AcpReleaseParentQualificationCleanupError
        ? primaryError
        : new AcpReleaseParentQualificationCleanupError();
    }
    await verifyInput(input.inputAuthority);
    if (primaryError) {
      try {
        await rmdir(root);
        await assertAbsent(root);
      } catch {
        throw new AcpReleaseParentQualificationCleanupError();
      }
      await verifyInput(input.inputAuthority);
      throw primaryError;
    }
  }

  assertExactCounts(globalCounts, { credential: 14, process: 14, prompt: 13 });
  if (reports.length !== 9) throw new Error("acp_release_parent_qualification_report_count_invalid");
  await rmdir(root);
  await assertAbsent(root);
  await verifyInput(input.inputAuthority);
  const qualificationDigest = privateDigest(privateSalt, {
    inputDigest: inputObservation.digest,
    reports,
    counters: globalCounts,
  });
  const observation = Object.freeze({
    schemaVersion: 1 as const,
    kind: "acp_release_parent_qualification_seal" as const,
    inputDigest: inputObservation.digest,
    qualificationDigest,
  });
  const seal = Object.freeze({
    safeObservation: () => observation,
    toJSON: () => observation,
  });
  STATES.set(seal, Object.freeze({
    inputAuthority: input.inputAuthority,
    inputDigest: inputObservation.digest,
    qualificationDigest,
    privateSalt,
    reports: Object.freeze(reports),
    counters: Object.freeze({ ...globalCounts }),
    laneRoots: Object.freeze([...laneRoots, root]),
  }));
  return seal;
}

/**
 * Fixed production entry. Its executors are current-install Task factories and
 * the independent production Meta owner; callers cannot inject a controlled
 * adapter, fake report, alternate effect counter or self-signed cleanup.
 */
export function createAcpReleaseParentProductionQualificationSeal(input: Readonly<{
  inputSeal: AcpReleaseParentInputSeal;
  qualificationRoot: string;
}>): Promise<AcpReleaseParentQualificationSeal> {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "inputSeal,qualificationRoot") {
    throw new Error("acp_release_parent_production_qualification_options_invalid");
  }
  const inputAuthority: AcpReleaseParentQualificationInputAuthority = Object.freeze({
    consume: () => consumeAcpReleaseParentInputSealBeforeFirstEffect(input.inputSeal),
    claim: () => claimAcpReleaseParentQualificationInputs(input.inputSeal),
    verify: () => verifyFrozenAcpReleaseParentInputSeal(input.inputSeal),
  });
  return createAcpReleaseParentQualificationSealWithExecutorsForTest({
    inputAuthority,
    qualificationRootParent: input.qualificationRoot,
    executors: Object.freeze({
      openCode: createProductionTaskLaneExecutor("opencode_acp_task_attestor"),
      codex: createProductionTaskLaneExecutor("codex_acp_task_attestor"),
      meta: createProductionMetaLaneExecutor(),
    }),
  });
}

export async function verifyFrozenAcpReleaseParentQualificationSeal(
  seal: AcpReleaseParentQualificationSeal,
): Promise<void> {
  const state = seal && typeof seal === "object" ? STATES.get(seal as object) : undefined;
  if (!state) throw new Error("acp_release_parent_qualification_seal_invalid");
  await verifyInput(state.inputAuthority);
  for (const laneRoot of state.laneRoots) await assertAbsent(laneRoot);
  const digest = privateDigest(state.privateSalt, {
    inputDigest: state.inputDigest,
    reports: state.reports,
    counters: state.counters,
  });
  if (digest !== state.qualificationDigest) {
    throw new Error("acp_release_parent_qualification_seal_invalid");
  }
}

function taskRuns(input: TaskQualificationInput): readonly Readonly<{
  profile: ExecutionProfileDefinitionV3;
  role: TaskRole;
}>[] {
  const providerFamily = input.issuer === "opencode_acp_task_attestor" ? "opencode" : "codex";
  const definition = createAcpTaskJourneyTemplateDefinition({ providerFamily, model: input.taskModel });
  const byId = new Map(definition.executionProfiles.map((profile) => [profile.executionProfileId, profile]));
  const profileIds: Readonly<Record<TaskRole, string>> = Object.freeze({
    conductor: "profile_conductor",
    publisher: "profile_publisher",
    worker: "profile_worker",
    reviewer: "profile_reviewer",
  });
  return Object.freeze(TASK_ROLES.map((role) => {
    const profile = byId.get(profileIds[role]);
    if (!profile || profile.providerFamily !== providerFamily) {
      throw new Error("acp_release_parent_qualification_task_profile_invalid");
    }
    return Object.freeze({ profile, role });
  }));
}

function createProductionTaskLaneExecutor(
  issuer: "opencode_acp_task_attestor" | "codex_acp_task_attestor",
): AcpReleaseParentQualificationLaneExecutor {
  const family = issuer === "opencode_acp_task_attestor" ? "opencode" : "codex";
  let qualificationRoot: string | undefined;
  let privateAuthority: ReturnType<typeof createAcpRuntimeHostPrivateAuthority> | undefined;
  let factory: SessionIdAcpProductionTaskNativeFactory | undefined;
  let hostInputs: ReturnType<typeof createAcpProductionHostInputs> | undefined;
  let activeReservation: ((effect: AcpQualificationEffect) => undefined) | undefined;
  const reserve = (effect: AcpQualificationEffect): undefined => {
    if (!activeReservation) throw new Error("acp_release_parent_qualification_effect_outside_run");
    return activeReservation(effect);
  };
  return Object.freeze({
    issuer,
    async run(input) {
      if (input.qualificationInput.issuer !== issuer
        || input.profile.providerFamily !== family
        || input.role === "meta" || "role" in input.profile) {
        throw new Error("acp_release_parent_qualification_lane_mismatch");
      }
      if (qualificationRoot && qualificationRoot !== input.qualificationRoot) {
        throw new Error("acp_release_parent_qualification_root_drift");
      }
      if (!factory || !privateAuthority || !hostInputs) {
        qualificationRoot = input.qualificationRoot;
        const configurationText = input.qualificationInput.environment[RUNTIME_ACP_CONFIGURATION_ENV];
        if (!configurationText) throw new Error("acp_release_parent_qualification_configuration_invalid");
        const configuration = parseAcpProductionConfiguration(configurationText);
        if (configuration.metaProfiles.length !== 0
          || (family === "opencode"
            ? !configuration.agents.opencode || configuration.agents.codex !== undefined
            : !configuration.agents.codex || configuration.agents.opencode !== undefined)) {
          throw new Error("acp_release_parent_qualification_configuration_invalid");
        }
        hostInputs = createAcpProductionHostInputs(
          configuration,
          input.qualificationInput.environment,
        );
        const runtimeDataDirectory = path.join(input.qualificationRoot, "runtime-data");
        await mkdir(runtimeDataDirectory, { mode: 0o700 });
        await chmod(runtimeDataDirectory, 0o700);
        privateAuthority = createAcpRuntimeHostPrivateAuthority({
          runtimeDataDirectory,
          environment: freshSupervisorEnvironment(issuer),
        });
        factory = family === "opencode"
          ? createOpenCodeAcpProductionTaskNativeFactory({
              beforeQualificationEffect: reserve,
            })
          : createCodexAcpProductionTaskNativeFactory({
              ...createSessionIdAcpProductionTaskProbePolicy(),
              beforeQualificationEffect: reserve,
            });
      }
      const selectedHostInputs = family === "opencode" ? hostInputs.openCode() : hostInputs.codex();
      if (!selectedHostInputs) throw new Error("acp_release_parent_qualification_configuration_invalid");
      if (activeReservation) throw new Error("acp_release_parent_qualification_parallel_forbidden");
      activeReservation = input.reserve;
      try {
        return await factory.checkReadiness(Object.freeze({
          profile: input.profile,
          role: input.role,
          hostInputs: selectedHostInputs,
          privateRootAuthority: privateAuthority.taskPrivateRootAuthority,
          identityVaultResolver: privateAuthority.taskIdentityVaults,
          signal: new AbortController().signal,
        }));
      } finally {
        activeReservation = undefined;
      }
    },
    async close() {
      if (activeReservation) throw new Error("acp_release_parent_qualification_parallel_forbidden");
      if (factory) await factory.close();
      privateAuthority?.close();
    },
  });
}

function createProductionMetaLaneExecutor(): AcpReleaseParentQualificationLaneExecutor {
  let qualificationRoot: string | undefined;
  let privateAuthority: ReturnType<typeof createAcpRuntimeHostPrivateAuthority> | undefined;
  let owner: AcpProductionMetaOwner | undefined;
  let metaProfileOptionId: MetaProfileOptionId | undefined;
  let activeReservation: ((effect: AcpQualificationEffect) => undefined) | undefined;
  const reserve = (effect: AcpQualificationEffect): undefined => {
    if (!activeReservation) throw new Error("acp_release_parent_qualification_effect_outside_run");
    return activeReservation(effect);
  };
  return Object.freeze({
    issuer: "acp_meta_attestor" as const,
    async run(input) {
      if (input.qualificationInput.issuer !== "acp_meta_attestor"
        || input.role !== "meta" || !("role" in input.profile) || input.profile.role !== "meta") {
        throw new Error("acp_release_parent_qualification_lane_mismatch");
      }
      if (qualificationRoot && qualificationRoot !== input.qualificationRoot) {
        throw new Error("acp_release_parent_qualification_root_drift");
      }
      if (!owner || !privateAuthority) {
        qualificationRoot = input.qualificationRoot;
        const configurationText = input.qualificationInput.environment[RUNTIME_ACP_CONFIGURATION_ENV];
        if (!configurationText) throw new Error("acp_release_parent_qualification_configuration_invalid");
        const configuration = parseAcpProductionConfiguration(configurationText);
        if (configuration.metaProfiles.length !== 1
          || configuration.metaProfiles[0]?.metaProfileOptionId !== input.qualificationInput.metaProfileOptionId
          || configuration.metaProfiles[0].profile.profileRevisionId !== input.profile.profileRevisionId) {
          throw new Error("acp_release_parent_qualification_meta_profile_invalid");
        }
        const hostInputs = createAcpProductionHostInputs(
          configuration,
          input.qualificationInput.environment,
        );
        const runtimeDataDirectory = path.join(input.qualificationRoot, "runtime-data");
        await mkdir(runtimeDataDirectory, { mode: 0o700 });
        await chmod(runtimeDataDirectory, 0o700);
        privateAuthority = createAcpRuntimeHostPrivateAuthority({
          runtimeDataDirectory,
          environment: freshSupervisorEnvironment("acp_meta_attestor"),
        });
        owner = createAcpProductionMetaOwner({
          configuration,
          hostInputs,
          privateAuthority,
          beforeQualificationEffect: reserve,
        });
        metaProfileOptionId = configuration.metaProfiles[0].metaProfileOptionId;
      }
      if (!metaProfileOptionId) throw new Error("acp_release_parent_qualification_meta_profile_invalid");
      if (activeReservation) throw new Error("acp_release_parent_qualification_parallel_forbidden");
      activeReservation = input.reserve;
      try {
        return await owner.providerComposition.checkMetaProfileQualificationReport(
          metaProfileOptionId,
        );
      } finally {
        activeReservation = undefined;
      }
    },
    async close() {
      if (activeReservation) throw new Error("acp_release_parent_qualification_parallel_forbidden");
      if (owner) await owner.close();
      privateAuthority?.close();
    },
  });
}

function freshSupervisorEnvironment(issuer: AcpReleaseAttestorIssuer): Readonly<Record<string, string>> {
  const { publicKey } = generateKeyPairSync("ed25519");
  return Object.freeze({
    AGENT_WORKSPACE_ACP_HOST_EPOCH: `host_epoch_release_qualification_${issuer}_${randomBytes(18).toString("base64url")}`,
    AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey
      .export({ type: "spki", format: "der" }).toString("base64url"),
  });
}

function metaRuns(input: MetaQualificationInput): readonly Readonly<{
  profile: MetaProfileDefinitionV3;
  role: "meta";
}>[] {
  const serialized = input.environment[RUNTIME_ACP_CONFIGURATION_ENV];
  if (!serialized) throw new Error("acp_release_parent_qualification_meta_profile_invalid");
  const configuration = parseAcpProductionConfiguration(serialized);
  const registrations = configuration.metaProfiles.filter((entry) => (
    entry.metaProfileOptionId === input.metaProfileOptionId
  ));
  if (configuration.metaProfiles.length !== 1 || registrations.length !== 1) {
    throw new Error("acp_release_parent_qualification_meta_profile_invalid");
  }
  return Object.freeze([Object.freeze({ profile: registrations[0]!.profile, role: "meta" as const })]);
}

function qualificationReservation(
  profileRevisionId: string,
  role: QualificationRole,
  local: EffectCounts,
  global: EffectCounts,
): (effect: AcpQualificationEffect) => undefined {
  return (effect) => {
    if (!effect || effect.profileRevisionId !== profileRevisionId || effect.role !== role) {
      throw new Error("acp_release_parent_qualification_effect_scope_invalid");
    }
    const field = effect.kind === "credential_lease_acquisition"
      ? "credential"
      : effect.kind === "process_generation_start"
        ? "process"
        : "prompt";
    local[field] += 1;
    global[field] += 1;
    if (global.credential > 14 || global.process > 14 || global.prompt > 13) {
      throw new Error("acp_release_parent_qualification_effect_budget_exceeded");
    }
    return undefined;
  };
}

function normalizeAvailableReport(
  issuer: AcpReleaseAttestorIssuer,
  profile: QualificationProfile,
  role: QualificationRole,
  report: AcpProviderAvailabilityReport,
  effects: EffectCounts,
): NormalizedReport {
  assertReportScope(issuer, profile, role, report);
  if (!report.available) {
    const cleanupReasons = report.unavailableReasons.filter((reason) => (
      typeof reason === "string"
      && /^[a-z][a-z0-9_]{1,127}$/u.test(reason)
      && reason.endsWith("_cleanup_unconfirmed")
    ));
    if (cleanupReasons.length > 0) {
      throw new AcpReleaseParentQualificationCleanupError(Object.freeze({
        issuer,
        profileRevisionId: profile.profileRevisionId,
        role,
        unavailableReasons: Object.freeze(cleanupReasons),
      }));
    }
    throw new AcpReleaseParentQualificationBlockedError(
      "acp_release_parent_qualification_unavailable",
      Object.freeze({
        issuer,
        profileRevisionId: profile.profileRevisionId,
        role,
        unavailableReasons: Object.freeze(report.unavailableReasons.map((reason) => (
          /^[a-z][a-z0-9_]{1,127}$/u.test(reason) ? reason : "qualification_unavailable"
        ))),
      }),
    );
  }
  if (report.protocolMajor !== 1
    || report.qualificationClass !== "binding_behavior"
    || !report.capabilityFingerprint || !SHA256.test(report.capabilityFingerprint)
    || !report.probeFingerprint || !SHA256.test(report.probeFingerprint)
    || !report.observedArtifactVersion) {
    throw new Error("acp_release_parent_qualification_report_invalid");
  }
  return Object.freeze({
    issuer,
    profileRevisionId: profile.profileRevisionId,
    role,
    providerFamily: profile.providerFamily as "opencode" | "codex",
    acpAgentKind: profile.acpAgentKind as "native_acp" | "codex_acp",
    protocolMajor: report.protocolMajor,
    observedArtifactVersion: report.observedArtifactVersion,
    ...(report.observedUpstreamVersion
      ? { observedUpstreamVersion: report.observedUpstreamVersion }
      : {}),
    capabilityFingerprint: report.capabilityFingerprint,
    probeFingerprint: report.probeFingerprint,
    effects: Object.freeze({ ...effects }),
  });
}

function assertReportScope(
  _issuer: AcpReleaseAttestorIssuer,
  profile: QualificationProfile,
  role: QualificationRole,
  report: AcpProviderAvailabilityReport,
): void {
  if (!report || report.profileRevisionId !== profile.profileRevisionId
    || report.providerFamily !== profile.providerFamily
    || report.acpAgentKind !== profile.acpAgentKind
    || report.role !== role) {
    throw new Error("acp_release_parent_qualification_report_scope_invalid");
  }
}

function assertExactCounts(actual: EffectCounts, expected: EffectCounts): void {
  if (actual.credential !== expected.credential
    || actual.process !== expected.process
    || actual.prompt !== expected.prompt) {
    throw new Error("acp_release_parent_qualification_effect_count_invalid");
  }
}

function assertCountsWithin(actual: EffectCounts, maximum: EffectCounts): void {
  if (actual.credential > maximum.credential
    || actual.process > maximum.process
    || actual.prompt > maximum.prompt) {
    throw new Error("acp_release_parent_qualification_effect_count_invalid");
  }
}

function isCleanupUnconfirmed(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith("_cleanup_unconfirmed");
}

async function verifyInput(authority: AcpReleaseParentQualificationInputAuthority): Promise<void> {
  try {
    await authority.verify();
  } catch {
    throw new Error("acp_release_parent_qualification_input_drift");
  }
}

function validateQualificationInputs(
  values: readonly AcpReleaseParentQualificationInput[],
): readonly [
  OpenCodeQualificationInput,
  CodexQualificationInput,
  MetaQualificationInput,
] {
  if (!Array.isArray(values) || values.length !== 3) {
    throw new Error("acp_release_parent_qualification_inputs_invalid");
  }
  const openCode = values[0];
  const codex = values[1];
  const meta = values[2];
  if (!isTaskQualificationInput(openCode, "opencode_acp_task_attestor")
    || !isTaskQualificationInput(codex, "codex_acp_task_attestor")
    || !isMetaQualificationInput(meta)) {
    throw new Error("acp_release_parent_qualification_inputs_invalid");
  }
  return Object.freeze([
    Object.freeze({
      issuer: "opencode_acp_task_attestor" as const,
      taskWorkspaceDirectory: openCode.taskWorkspaceDirectory,
      taskModel: openCode.taskModel,
      environment: openCode.environment,
    }),
    Object.freeze({
      issuer: "codex_acp_task_attestor" as const,
      taskWorkspaceDirectory: codex.taskWorkspaceDirectory,
      taskModel: codex.taskModel,
      environment: codex.environment,
    }),
    Object.freeze({
      issuer: "acp_meta_attestor" as const,
      metaProfileOptionId: meta.metaProfileOptionId,
      environment: meta.environment,
    }),
  ]);
}

function isTaskQualificationInput(
  value: AcpReleaseParentQualificationInput | undefined,
  issuer: TaskQualificationInput["issuer"],
): value is TaskQualificationInput {
  return value?.issuer === issuer
    && "taskWorkspaceDirectory" in value
    && typeof value.taskWorkspaceDirectory === "string"
    && typeof value.taskModel === "string"
    && !!value.environment && typeof value.environment === "object";
}

function isMetaQualificationInput(
  value: AcpReleaseParentQualificationInput | undefined,
): value is MetaQualificationInput {
  return value?.issuer === "acp_meta_attestor"
    && typeof value.metaProfileOptionId === "string"
    && !!value.environment && typeof value.environment === "object";
}

function validateOptions(input: Readonly<{
  inputAuthority: AcpReleaseParentQualificationInputAuthority;
  qualificationRootParent: string;
  executors: Readonly<{
    openCode: AcpReleaseParentQualificationLaneExecutor;
    codex: AcpReleaseParentQualificationLaneExecutor;
    meta: AcpReleaseParentQualificationLaneExecutor;
  }>;
}>): void {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "executors,inputAuthority,qualificationRootParent"
    || !input.inputAuthority || typeof input.inputAuthority.consume !== "function"
    || typeof input.inputAuthority.claim !== "function" || typeof input.inputAuthority.verify !== "function"
    || !input.executors || Object.keys(input.executors).sort().join(",") !== "codex,meta,openCode"
    || ![input.executors.openCode, input.executors.codex, input.executors.meta]
      .every((executor) => executor && typeof executor.run === "function" && typeof executor.close === "function")) {
    throw new Error("acp_release_parent_qualification_options_invalid");
  }
}

async function createFreshPrivateRoot(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error("acp_release_parent_qualification_root_invalid");
  const requestedParent = path.dirname(directory);
  const canonicalParent = await realpath(requestedParent).catch(() => undefined);
  if (!canonicalParent || canonicalParent !== requestedParent) {
    throw new Error("acp_release_parent_qualification_root_invalid");
  }
  if (await lstat(directory).then(() => true, (error: NodeJS.ErrnoException) => (
    error.code === "ENOENT" ? false : Promise.reject(error)
  ))) {
    throw new Error("acp_release_parent_qualification_root_invalid");
  }
  await mkdir(directory, { mode: 0o700 });
  const canonical = await realpath(directory).catch(() => undefined);
  const status = canonical ? await lstat(canonical) : undefined;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!canonical || canonical !== directory || !status?.isDirectory() || status.isSymbolicLink()
    || uid === undefined || status.uid !== uid || (status.mode & 0o7777) !== 0o700
    || (await readdir(canonical)).length !== 0) {
    throw new Error("acp_release_parent_qualification_root_invalid");
  }
  return canonical;
}

async function assertAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  throw new AcpReleaseParentQualificationCleanupError();
}

function validInputObservation(value: AcpReleaseParentInputSealSafeObservation): boolean {
  return value?.schemaVersion === 1
    && value.kind === "acp_release_parent_input_seal"
    && SHA256.test(value.digest);
}

function privateDigest(privateSalt: Buffer, value: unknown): string {
  return `sha256:${createHmac("sha256", privateSalt).update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
