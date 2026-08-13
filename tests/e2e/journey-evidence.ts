import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export type JourneyOutcome = "PASS" | "FAIL" | "BLOCKED_CAPABILITY" | "NOT_EXERCISED" | "NOT_APPLICABLE";

export type JourneyEvidenceClass =
  | "deterministic_fake"
  | "browser_rendered"
  | "electron_ipc"
  | "qualified_acp_provider"
  | "qualified_acp_meta"
  | "superseded_protocol";

export type JourneyEvidenceSurface = "domain" | "runtime-host" | "browser" | "desktop" | "provider";

export type JourneyEvidenceIssuer =
  | "runtime_host"
  | "browser_ui_driver"
  | "electron_ui_driver"
  | "opencode_acp_task_attestor"
  | "codex_acp_task_attestor"
  | "acp_meta_attestor"
  | "superseded_protocol_fixture";

export type JourneyEvidenceDigests = Readonly<{
  sourceDigest: string;
  buildDigest: string;
  schemaDigest: string;
  providerPolicyDigest: string;
  policyDigest: string;
}>;

export type JourneyEvidenceLineage = Readonly<{
  runtimeInstanceId: string;
}>;

export type JourneyEvidenceStream = Readonly<{
  issuer: JourneyEvidenceIssuer;
  evidenceClass: JourneyEvidenceClass;
  surface: JourneyEvidenceSurface;
}>;

export type JourneyReleaseIdentity = Readonly<{
  releaseRunId: string;
  nonce: string;
  digests: JourneyEvidenceDigests;
}>;

export type JourneyEvidenceAuthorityInput = JourneyReleaseIdentity & Readonly<{
  bundleCellId: string;
  scenarioId: string;
  lineage: JourneyEvidenceLineage;
}>;

declare const JOURNEY_EVIDENCE_AUTHORITY_TYPE: unique symbol;

export type JourneyEvidenceAuthority = JourneyEvidenceAuthorityInput & JourneyEvidenceStream & Readonly<{
  [JOURNEY_EVIDENCE_AUTHORITY_TYPE]: true;
}>;

export type JourneyEvidenceCellDeclaration = Readonly<{
  bundleCellId: string;
  scenarioId: string;
  lineage: JourneyEvidenceLineage;
  required: boolean;
  streams: readonly JourneyEvidenceStream[];
}>;

export type JourneyEvidenceMatrix = JourneyReleaseIdentity & Readonly<{
  cells: readonly JourneyEvidenceCellDeclaration[];
}>;

export type JourneyEvidenceCellResult = JourneyEvidenceAuthorityInput & JourneyEvidenceStream & Readonly<{
  journeyId: string;
  outcome: JourneyOutcome;
}>;

export type DeepSearchCheckpoint = "DS-01" | "DS-02" | "DS-03" | "DS-04" | "DS-05" | "DS-06" | "DS-07" | "DS-08" | "DS-09";

export type FullJourneyCheckpoint =
  | "J-01"
  | "J-02"
  | "J-03"
  | "J-04"
  | "J-05"
  | "J-06"
  | "J-07"
  | "J-08"
  | "J-09"
  | "J-10"
  | "J-11"
  | "J-12";

export type JourneyCheckpointName = DeepSearchCheckpoint | FullJourneyCheckpoint;

export const DEEP_SEARCH_CHECKPOINTS = Object.freeze([
  "DS-01", "DS-02", "DS-03", "DS-04", "DS-05", "DS-06", "DS-07", "DS-08", "DS-09",
] as const satisfies readonly DeepSearchCheckpoint[]);

export const FULL_JOURNEY_CHECKPOINTS = Object.freeze([
  "J-01", "J-02", "J-03", "J-04", "J-05", "J-06", "J-07", "J-08", "J-09", "J-10", "J-11", "J-12",
] as const satisfies readonly FullJourneyCheckpoint[]);

export type JourneyAssertion = Readonly<{
  id: string;
  outcome: JourneyOutcome;
  /** Assertions are required unless explicitly marked diagnostic-only. */
  required?: boolean;
}>;

export type JourneyCheckpointSummary = Readonly<{
  durableWriter: string;
  durableIdentity: string;
  command: Readonly<{
    commandId: string;
    idempotencyKey: string;
    fence: string;
  }>;
  externalEffect: Readonly<{
    kind: string;
    recovery: string;
    effectIdentity?: string;
  }>;
}>;

export type JourneyCheckpoint = Readonly<{
  checkpoint: JourneyCheckpointName;
  eventKind: "command_recorded" | "effect_accepted" | "provider_fact_observed" | "domain_transition" | "read_model_projected" | "surface_rendered" | "assertion" | "cleanup";
  observedAt: string;
  identities?: Readonly<Record<string, string>>;
  summary: JourneyCheckpointSummary;
  observation: Readonly<Record<string, unknown>>;
  assertions: readonly JourneyAssertion[];
}>;

const CHECKPOINTS = new Set<JourneyCheckpointName>([
  ...DEEP_SEARCH_CHECKPOINTS,
  ...FULL_JOURNEY_CHECKPOINTS,
]);

const OUTCOMES = new Set<JourneyOutcome>([
  "PASS", "FAIL", "BLOCKED_CAPABILITY", "NOT_EXERCISED", "NOT_APPLICABLE",
]);

const EVIDENCE_CLASSES = new Set<JourneyEvidenceClass>([
  "deterministic_fake", "browser_rendered", "electron_ipc", "qualified_acp_provider", "qualified_acp_meta", "superseded_protocol",
]);
const SURFACES = new Set<JourneyEvidenceSurface>(["domain", "runtime-host", "browser", "desktop", "provider"]);
const ISSUERS = new Set<JourneyEvidenceIssuer>([
  "runtime_host", "browser_ui_driver", "electron_ui_driver", "opencode_acp_task_attestor", "codex_acp_task_attestor", "acp_meta_attestor", "superseded_protocol_fixture",
]);
const EVENT_KINDS = new Set<JourneyCheckpoint["eventKind"]>([
  "command_recorded", "effect_accepted", "provider_fact_observed", "domain_transition", "read_model_projected", "surface_rendered", "assertion", "cleanup",
]);

const MAX_PAYLOAD_BYTES = 1_000_000;
const MAX_STRING_LENGTH = 65_536;
const MAX_NODES = 50_000;
const MAX_DEPTH = 32;
const ALIAS_KEY_FILE = ".alias-key";
const MANIFEST_FILE = "manifest.json";
const LEDGER_FILE = "checkpoint-ledger.jsonl";
const ASSERTIONS_FILE = "assertions.json";
const CHECKSUMS_FILE = "checksums.sha256";
const MANIFEST_RESERVED_FIELDS = new Set([
  "schemaVersion", "journeyId", "releaseRunId", "nonce", "bundleCellId", "scenarioId", "issuer", "evidenceClass", "surface", "status", "outcome", "digests", "lineage", "checkpointContract",
]);
const EVIDENCE_SCHEMA_VERSION = 3;
const DIGEST_FIELDS = ["sourceDigest", "buildDigest", "schemaDigest", "providerPolicyDigest", "policyDigest"] as const;
const AUTHORITY_REGISTRY = new WeakSet<object>();
const AUTHORITY_PROFILE: Readonly<Record<JourneyEvidenceIssuer, Readonly<{ evidenceClass: JourneyEvidenceClass; surface: JourneyEvidenceSurface }>>> = Object.freeze({
  runtime_host: Object.freeze({ evidenceClass: "deterministic_fake", surface: "runtime-host" }),
  browser_ui_driver: Object.freeze({ evidenceClass: "browser_rendered", surface: "browser" }),
  electron_ui_driver: Object.freeze({ evidenceClass: "electron_ipc", surface: "desktop" }),
  opencode_acp_task_attestor: Object.freeze({ evidenceClass: "qualified_acp_provider", surface: "provider" }),
  codex_acp_task_attestor: Object.freeze({ evidenceClass: "qualified_acp_provider", surface: "provider" }),
  acp_meta_attestor: Object.freeze({ evidenceClass: "qualified_acp_meta", surface: "provider" }),
  superseded_protocol_fixture: Object.freeze({ evidenceClass: "superseded_protocol", surface: "runtime-host" }),
});

const SENSITIVE_TEXT = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/i,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/i,
  /\bBearer\s+[^\s"']{8,}/i,
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY|AUTH_TOKEN|PASSWORD|SECRET|TOKEN)\s*=\s*["']?[^\s"']+/i,
  /(?:^|\s)--(?:api[-_]?key|access[-_]?key|authorization|client[-_]?secret|password|secret|token)(?:=|\s+)\S+/i,
  /["'][A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|auth[_-]?token|authorization|client[_-]?secret|cookie|password|private[_-]?key|secret|token)["']\s*:\s*["'][^"']+["']/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i,
  /(?:^|[\s"'(=])\/(?:Users|home|private|tmp|var|Volumes|etc|opt|root|srv|mnt)(?:\/|$)/,
  /(?:^|[\s"'(=])[A-Za-z]:[\\/][^\s"']*/i,
  /(?:^|[\s"'(=])\\\\[^\s\\]+\\[^\s\\]+/,
] as const;

const SENSITIVE_FIELD = /^(?:authorization|cookie|password|passwd|passphrase|(?:[a-z0-9]+_)*(?:api_key|access_key|auth_token|client_secret|password|private_key|refresh_token|secret|token))$/i;

/** Must remain exactly aligned with runtime-contracts/src/ids.ts `IdPrefix`. */
const PUBLIC_RUNTIME_ID_PREFIXES = new Set([
  "template",
  "template_version",
  "template_draft",
  "task",
  "run",
  "logical_session",
  "card_session_slot",
  "planning_fence",
  "session_control",
  "workspace_file_observation",
  "workspace_effect",
  "architecture",
  "provider_host",
  "binding",
  "message",
  "relay_block",
  "message_forward",
  "human_intervention",
  "inbox",
  "input",
  "session_turn",
  "provider_fact",
  "attention",
  "presentation",
  "async_operation",
  "command",
  "profile",
  "agent_card",
  "workspace",
  "evidence",
  "task_setup_draft",
  "meta_session",
  "meta_turn",
  "meta_patch_proposal",
  "meta_profile",
  "meta_profile_option",
  "meta_message",
] as const);

const PUBLIC_IDENTITY_FIELDS: Readonly<Record<string, string>> = {
  template: "template",
  templateId: "template",
  templateVersion: "template_version",
  templateVersionId: "template_version",
  templateDraft: "template_draft",
  templateDraftId: "template_draft",
  task: "task",
  taskId: "task",
  run: "run",
  runId: "run",
  taskRunId: "run",
  logicalSession: "logical_session",
  logicalSessionId: "logical_session",
  cardSessionSlot: "card_session_slot",
  cardSessionSlotId: "card_session_slot",
  planningFence: "planning_fence",
  planningFenceId: "planning_fence",
  conductorPlanningFenceId: "planning_fence",
  sessionControl: "session_control",
  sessionControlId: "session_control",
  sessionControlAuditId: "session_control",
  workspaceFileObservation: "workspace_file_observation",
  workspaceFileObservationId: "workspace_file_observation",
  observationId: "workspace_file_observation",
  workspaceEffect: "workspace_effect",
  workspaceEffectId: "workspace_effect",
  workspaceEffectIntentId: "workspace_effect",
  architecture: "architecture",
  architectureId: "architecture",
  architectureSnapshotId: "architecture",
  providerHost: "provider_host",
  providerHostId: "provider_host",
  binding: "binding",
  bindingId: "binding",
  providerSessionBindingId: "binding",
  message: "message",
  messageId: "message",
  sessionMessageId: "message",
  sourceMessageId: "message",
  relayBlock: "relay_block",
  relayBlockId: "relay_block",
  messageForward: "message_forward",
  messageForwardId: "message_forward",
  humanIntervention: "human_intervention",
  humanInterventionId: "human_intervention",
  inbox: "inbox",
  inboxId: "inbox",
  sessionInboxItemId: "inbox",
  input: "input",
  inputId: "input",
  inputSubmissionId: "input",
  sessionTurn: "session_turn",
  sessionTurnId: "session_turn",
  providerFact: "provider_fact",
  providerFactId: "provider_fact",
  attention: "attention",
  attentionId: "attention",
  presentation: "presentation",
  presentationId: "presentation",
  presentationLeaseId: "presentation",
  asyncOperation: "async_operation",
  asyncOperationId: "async_operation",
  command: "command",
  commandId: "command",
  runtimeCommandId: "command",
  profile: "profile",
  profileId: "profile",
  executionProfileId: "profile",
  agentCard: "agent_card",
  agentCardId: "agent_card",
  workspace: "workspace",
  workspaceId: "workspace",
  evidence: "evidence",
  evidenceId: "evidence",
  evidenceReferenceId: "evidence",
  taskSetupDraft: "task_setup_draft",
  taskSetupDraftId: "task_setup_draft",
  metaSession: "meta_session",
  metaSessionId: "meta_session",
  metaTurn: "meta_turn",
  metaTurnId: "meta_turn",
  metaPatchProposal: "meta_patch_proposal",
  metaPatchProposalId: "meta_patch_proposal",
  metaProfile: "meta_profile",
  metaProfileId: "meta_profile",
  metaProfileOption: "meta_profile_option",
  metaProfileOptionId: "meta_profile_option",
  metaMessage: "meta_message",
  metaMessageId: "meta_message",
};

const IDENTITY_LIKE_FIELD = /(?:Id|Ids|ID|IDs|Identity|Identities|_id|_ids|_identity|_identities)$/;
const PROVIDER_NATIVE_VALUE = /^(?:(?:call|chatcmpl|completion|conversation|evt|item|msg|request|resp|response|ses|session|thread|turn)[_-][A-Za-z0-9-]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const PROVIDER_NATIVE_ENTROPIC_VALUE = /^(?:(?:call|chatcmpl|completion|conversation|evt|item|msg|request|resp|response|ses|session|thread|turn)[_-](?=[A-Za-z0-9-]{6,}$)(?=[A-Za-z0-9-]*(?:\d|[A-Za-z0-9-]{20}))[A-Za-z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SEMANTIC_OBSERVATION_FIELDS = new Set([
  "event", "events", "eventKind", "eventKinds", "factKind", "factKinds", "kind", "kinds", "mode", "outcome", "reason", "recovery", "state", "states", "status", "statuses", "surface", "writer",
]);

export function createRuntimeHostEvidenceAuthority(input: JourneyEvidenceAuthorityInput): JourneyEvidenceAuthority {
  return createEvidenceAuthority("runtime_host", input);
}

export function createBrowserEvidenceAuthority(input: JourneyEvidenceAuthorityInput): JourneyEvidenceAuthority {
  return createEvidenceAuthority("browser_ui_driver", input);
}

export function createElectronEvidenceAuthority(input: JourneyEvidenceAuthorityInput): JourneyEvidenceAuthority {
  return createEvidenceAuthority("electron_ui_driver", input);
}

export function createOpenCodeAcpTaskEvidenceAuthority(input: JourneyEvidenceAuthorityInput): JourneyEvidenceAuthority {
  return createEvidenceAuthority("opencode_acp_task_attestor", input);
}

export function createCodexAcpTaskEvidenceAuthority(input: JourneyEvidenceAuthorityInput): JourneyEvidenceAuthority {
  return createEvidenceAuthority("codex_acp_task_attestor", input);
}

export function createAcpMetaEvidenceAuthority(input: JourneyEvidenceAuthorityInput): JourneyEvidenceAuthority {
  return createEvidenceAuthority("acp_meta_attestor", input);
}

export function createSupersededEvidenceAuthority(input: JourneyEvidenceAuthorityInput): JourneyEvidenceAuthority {
  return createEvidenceAuthority("superseded_protocol_fixture", input);
}

export function verifyJourneyEvidenceMatrix(
  matrix: JourneyEvidenceMatrix,
  results: readonly JourneyEvidenceCellResult[],
): void {
  const release = validateReleaseIdentity(matrix);
  if (!Array.isArray(matrix.cells) || matrix.cells.length === 0) throw new Error("journey_evidence_matrix_cells_required");

  const cells = new Map<string, JourneyEvidenceCellDeclaration>();
  for (const cell of matrix.cells) {
    validateCellDeclaration(cell);
    const key = cellKey(cell);
    if (cells.has(key)) throw new Error("journey_evidence_matrix_cell_duplicate");
    cells.set(key, cell);
  }

  if (!Array.isArray(results)) throw new Error("journey_evidence_results_invalid");
  const observedStreams = new Map<string, Set<string>>();
  for (const result of results) {
    validateCellResult(result);
    if (!isDeepStrictEqual(release, releaseIdentityOf(result))) {
      throw new Error("journey_evidence_release_mismatch");
    }
    const key = cellKey(result);
    const declaration = cells.get(key);
    if (!declaration) throw new Error("journey_evidence_cell_not_declared");
    const expectedStreams = new Set(declaration.streams.map(streamKey));
    const observedStreamKey = streamKey(result);
    if (!expectedStreams.has(observedStreamKey)) throw new Error("journey_evidence_stream_not_declared");

    const streams = observedStreams.get(key) ?? new Set<string>();
    if (streams.has(observedStreamKey)) throw new Error("journey_evidence_stream_duplicate");
    streams.add(observedStreamKey);
    observedStreams.set(key, streams);

    const normalizedLineage = normalizeLineage(result.lineage);
    if (!isDeepStrictEqual(normalizeLineage(declaration.lineage), normalizedLineage)) {
      throw new Error("journey_evidence_cell_lineage_mismatch");
    }
    if (declaration.required && result.outcome !== "PASS") {
      throw new Error("journey_evidence_required_cell_not_pass");
    }
  }

  for (const [key, declaration] of cells) {
    if (!declaration.required) continue;
    const streams = observedStreams.get(key);
    if (!streams || declaration.streams.some((stream) => !streams.has(streamKey(stream)))) {
      throw new Error("journey_evidence_required_cell_missing");
    }
  }
}

function createEvidenceAuthority(
  issuer: JourneyEvidenceIssuer,
  input: JourneyEvidenceAuthorityInput,
): JourneyEvidenceAuthority {
  const release = validateReleaseIdentity(input);
  validateCellIdentity(input);
  const lineage = normalizeLineage(input.lineage);
  const profile = AUTHORITY_PROFILE[issuer];
  const authority = {
    ...release,
    bundleCellId: input.bundleCellId,
    scenarioId: input.scenarioId,
    lineage,
    issuer,
    evidenceClass: profile.evidenceClass,
    surface: profile.surface,
  } as JourneyEvidenceAuthority;
  Object.freeze(authority);
  AUTHORITY_REGISTRY.add(authority);
  return authority;
}

export class JourneyEvidenceRecorder {
  readonly #root: string;
  readonly #journeyId: string;
  readonly #authority: JourneyEvidenceAuthority;
  readonly #providedAliasKey?: Uint8Array;
  #aliasKey?: Uint8Array;
  #sequence = 0;
  #initialized = false;
  #finalized = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #assertions = new Map<string, JourneyAssertion>();
  readonly #recordedCheckpoints = new Set<JourneyCheckpointName>();
  readonly #requiredCheckpoints: ReadonlySet<JourneyCheckpointName>;

  constructor(input: Readonly<{
    root: string;
    journeyId: string;
    authority: JourneyEvidenceAuthority;
    aliasKey?: Uint8Array;
    /** Runner-owned checkpoint contract. Scenario manifests cannot override it. */
    requiredCheckpoints?: readonly JourneyCheckpointName[];
  }>) {
    if (!path.isAbsolute(input.root)) throw new Error("journey_evidence_root_must_be_absolute");
    if (input.journeyId.length > 128 || !/^journey_[A-Za-z0-9-]+$/.test(input.journeyId)) throw new Error("journey_evidence_id_invalid");
    if (!input.authority || !AUTHORITY_REGISTRY.has(input.authority)) throw new Error("journey_evidence_authority_invalid");
    if (input.aliasKey && (input.aliasKey.byteLength < 16 || input.aliasKey.byteLength > 128)) {
      throw new Error("journey_evidence_alias_key_invalid");
    }
    this.#root = input.root;
    this.#journeyId = input.journeyId;
    this.#authority = input.authority;
    this.#providedAliasKey = input.aliasKey ? Uint8Array.from(input.aliasKey) : undefined;
    const requiredCheckpoints = input.requiredCheckpoints ?? DEEP_SEARCH_CHECKPOINTS;
    if (!Array.isArray(requiredCheckpoints)
      || requiredCheckpoints.length === 0
      || new Set(requiredCheckpoints).size !== requiredCheckpoints.length
      || requiredCheckpoints.some((checkpoint) => !CHECKPOINTS.has(checkpoint))) {
      throw new Error("journey_evidence_required_checkpoints_invalid");
    }
    this.#requiredCheckpoints = new Set(requiredCheckpoints);
  }

  initialize(manifest: Readonly<Record<string, unknown>>): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#initialized) throw new Error("journey_evidence_already_initialized");
      if (!isPlainObject(manifest)) throw new Error("journey_evidence_manifest_invalid");
      for (const field of MANIFEST_RESERVED_FIELDS) {
        if (Object.hasOwn(manifest, field)) throw new Error("journey_evidence_manifest_reserved_field");
      }
      assertEvidenceSafe(manifest);
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await assertSafeDirectory(this.#root, "journey_evidence_root_unsafe");
      await chmod(this.#root, 0o700);

      const manifestFile = path.join(this.#root, MANIFEST_FILE);
      const ledgerFile = path.join(this.#root, LEDGER_FILE);
      const aliasKeyFile = path.join(this.#root, ALIAS_KEY_FILE);
      const existingManifest = await readJsonIfExists(manifestFile);
      const expectedManifest = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        journeyId: this.#journeyId,
        ...serializeAuthority(this.#authority),
        ...manifest,
        checkpointContract: [...this.#requiredCheckpoints],
      };

      if (existingManifest !== undefined) {
        if (!isDeepStrictEqual(existingManifest, expectedManifest)) throw new Error("journey_evidence_manifest_mismatch");
        await requireRegularFile(aliasKeyFile, "journey_evidence_alias_key_missing");
        const persistedAliasKey = await readFileOrUndefined(aliasKeyFile);
        if (!persistedAliasKey) throw new Error("journey_evidence_alias_key_missing");
        if (persistedAliasKey.byteLength < 16 || persistedAliasKey.byteLength > 128) throw new Error("journey_evidence_alias_key_invalid");
        if (this.#providedAliasKey && !sameBytes(this.#providedAliasKey, persistedAliasKey)) {
          throw new Error("journey_evidence_alias_key_mismatch");
        }
        this.#aliasKey = Uint8Array.from(persistedAliasKey);
        await requireRegularFile(ledgerFile, "journey_evidence_ledger_missing");
        await Promise.all([chmod(manifestFile, 0o600), chmod(ledgerFile, 0o600), chmod(aliasKeyFile, 0o600)]);
        await this.#restoreLedger(await readFile(ledgerFile, "utf8"));
      } else {
        const existingEntries = await readdir(this.#root);
        if (existingEntries.length > 0) throw new Error("journey_evidence_bundle_incomplete");
        this.#aliasKey = this.#providedAliasKey ? Uint8Array.from(this.#providedAliasKey) : Uint8Array.from(randomBytes(32));
        await writePrivateBytes(aliasKeyFile, this.#aliasKey, "wx");
        await writePrivateJson(manifestFile, expectedManifest, "wx");
        await writeFile(ledgerFile, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(ledgerFile, 0o600);
      }

      const assertionsExists = await fileExists(path.join(this.#root, ASSERTIONS_FILE));
      const checksumsExists = await fileExists(path.join(this.#root, CHECKSUMS_FILE));
      if (checksumsExists && !assertionsExists) throw new Error("journey_evidence_bundle_finalization_corrupt");
      if (assertionsExists && !checksumsExists) await writeChecksums(this.#root);
      if (assertionsExists) {
        await verifyChecksums(this.#root);
        this.#finalized = true;
      }
      this.#initialized = true;
    });
  }

  aliasNative(kind: string, nativeValue: string): string {
    this.#assertInitialized();
    if (!/^[a-z][a-z0-9_]*$/.test(kind) || !nativeValue) throw new Error("journey_evidence_alias_input_invalid");
    if (nativeValue.length > MAX_STRING_LENGTH) throw new Error("journey_evidence_string_too_large");
    const digest = createHmac("sha256", this.#aliasKey!).update(`${kind}\0${nativeValue}`).digest("hex").slice(0, 20);
    return `alias_${kind}_${digest}`;
  }

  record(checkpoint: JourneyCheckpoint): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      validateCheckpoint(checkpoint);
      this.#assertAssertionsCompatible(checkpoint.assertions);
      const sequence = this.#sequence + 1;
      const entry = {
        ...checkpoint,
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        journeyId: this.#journeyId,
        ...serializeAuthority(this.#authority),
        sequence,
      };
      assertEvidenceSafe(entry);
      await appendFile(path.join(this.#root, LEDGER_FILE), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(path.join(this.#root, LEDGER_FILE), 0o600);
      this.#sequence = sequence;
      this.#rememberAssertions(checkpoint.assertions);
      this.#recordedCheckpoints.add(checkpoint.checkpoint);
    });
  }

  writeJsonAttachment(name: string, value: Readonly<Record<string, unknown>>): Promise<string> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      if (name.length > 128 || !/^[a-z0-9][a-z0-9._-]*\.json$/.test(name) || name.includes("..")) {
        throw new Error("journey_evidence_attachment_name_invalid");
      }
      if (!isPlainObject(value)) throw new Error("journey_evidence_attachment_invalid");
      assertEvidenceSafe(value);
      assertObservationIdentitySafety(value);
      const directory = path.join(this.#root, "attachments");
      const directoryStatus = await lstatOrUndefined(directory);
      if (directoryStatus) {
        if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
          throw new Error("journey_evidence_attachment_directory_unsafe");
        }
      } else {
        await mkdir(directory, { mode: 0o700 });
        await assertSafeDirectory(directory, "journey_evidence_attachment_directory_unsafe");
      }
      await chmod(directory, 0o700);
      const file = path.join(directory, name);
      if (await fileExists(file)) throw new Error("journey_evidence_attachment_exists");
      try {
        await writePrivateJson(file, value, "wx");
      } catch (error) {
        if (hasCode(error, "EEXIST")) throw new Error("journey_evidence_attachment_exists");
        throw error;
      }
      return `attachments/${name}`;
    });
  }

  finalize(input: Readonly<{
    outcome: JourneyOutcome;
    assertions: readonly JourneyAssertion[];
    residualRisks: readonly string[];
  }>): Promise<JourneyEvidenceCellResult> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      assertEvidenceSafe(input);
      if (!OUTCOMES.has(input.outcome)) throw new Error("journey_evidence_outcome_invalid");
      if (!Array.isArray(input.residualRisks) || input.residualRisks.some((risk) => !isNonEmptyString(risk))) {
        throw new Error("journey_evidence_residual_risks_invalid");
      }
      const finalAssertions = validateAssertions(input.assertions, "journey_evidence_final_assertions_required");
      const finalById = new Map(finalAssertions.map((assertion) => [assertion.id, assertion]));
      for (const assertion of this.#assertions.values()) {
        if (assertion.required === false) continue;
        const finalAssertion = finalById.get(assertion.id);
        if (!finalAssertion) throw new Error("journey_evidence_required_assertion_missing");
        if (finalAssertion.outcome !== assertion.outcome) throw new Error("journey_evidence_assertion_outcome_mismatch");
      }
      if (input.outcome === "PASS") {
        const combined = [...this.#assertions.values(), ...finalAssertions];
        if (combined.some((assertion) => assertion.required !== false && assertion.outcome !== "PASS")) {
          throw new Error("journey_evidence_pass_has_unsatisfied_assertion");
        }
        if ([...this.#requiredCheckpoints].some((checkpoint) => !this.#recordedCheckpoints.has(checkpoint))) {
          throw new Error("journey_evidence_pass_missing_checkpoint");
        }
      }
      await writePrivateJson(path.join(this.#root, ASSERTIONS_FILE), {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        journeyId: this.#journeyId,
        ...serializeAuthority(this.#authority),
        outcome: input.outcome,
        assertions: input.assertions,
        residualRisks: input.residualRisks,
      }, "wx");
      await writeChecksums(this.#root);
      this.#finalized = true;
      return Object.freeze({
        journeyId: this.#journeyId,
        ...serializeAuthority(this.#authority),
        outcome: input.outcome,
      });
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("journey_evidence_not_initialized");
  }

  #assertWritable(): void {
    this.#assertInitialized();
    if (this.#finalized) throw new Error("journey_evidence_finalized");
  }

  #rememberAssertions(assertions: readonly JourneyAssertion[]): void {
    for (const assertion of assertions) {
      const existing = this.#assertions.get(assertion.id);
      if (existing && (existing.outcome !== assertion.outcome || isRequired(existing) !== isRequired(assertion))) {
        throw new Error("journey_evidence_assertion_conflict");
      }
      this.#assertions.set(assertion.id, assertion);
    }
  }

  #assertAssertionsCompatible(assertions: readonly JourneyAssertion[]): void {
    for (const assertion of assertions) {
      const existing = this.#assertions.get(assertion.id);
      if (existing && (existing.outcome !== assertion.outcome || isRequired(existing) !== isRequired(assertion))) {
        throw new Error("journey_evidence_assertion_conflict");
      }
    }
  }

  async #restoreLedger(source: string): Promise<void> {
    const rawLines = source.split("\n");
    if (rawLines.at(-1) !== "" || rawLines.slice(0, -1).some((line) => line.length === 0)) {
      throw new Error("journey_evidence_ledger_invalid");
    }
    const lines = rawLines.slice(0, -1);
    for (const [index, line] of lines.entries()) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error("journey_evidence_ledger_invalid");
      }
      assertEvidenceSafe(entry);
      if (!isPlainObject(entry)
        || entry.schemaVersion !== EVIDENCE_SCHEMA_VERSION
        || entry.journeyId !== this.#journeyId
        || entry.sequence !== index + 1) {
        throw new Error("journey_evidence_ledger_invalid");
      }
      assertEntryAuthority(entry, this.#authority);
      const {
        schemaVersion: _schemaVersion,
        journeyId: _journeyId,
        sequence: _sequence,
        releaseRunId: _releaseRunId,
        nonce: _nonce,
        bundleCellId: _bundleCellId,
        scenarioId: _scenarioId,
        issuer: _issuer,
        evidenceClass: _evidenceClass,
        surface: _surface,
        digests: _digests,
        lineage: _lineage,
        ...checkpointFields
      } = entry;
      const checkpoint = checkpointFields as unknown as JourneyCheckpoint;
      validateCheckpoint(checkpoint);
      this.#assertAssertionsCompatible(checkpoint.assertions);
      this.#rememberAssertions(checkpoint.assertions);
      this.#recordedCheckpoints.add(checkpoint.checkpoint);
      this.#sequence = index + 1;
    }
  }
}

export function assertEvidenceSafe(value: unknown): void {
  const seen = new WeakSet<object>();
  const counter = { nodes: 0, strings: 0 };
  visitEvidenceValue(value, "$", 0, seen, counter);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("journey_evidence_payload_not_json");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("journey_evidence_payload_too_large");
}

function visitEvidenceValue(
  value: unknown,
  field: string,
  depth: number,
  seen: WeakSet<object>,
  counter: { nodes: number; strings: number },
): void {
  counter.nodes += 1;
  if (counter.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("journey_evidence_payload_too_large");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("journey_evidence_payload_not_json");
    return;
  }
  if (typeof value === "string") {
    counter.strings += 1;
    scanEvidenceString(value);
    return;
  }
  if (typeof value !== "object") throw new Error("journey_evidence_payload_not_json");
  if (seen.has(value)) throw new Error("journey_evidence_payload_not_json");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitEvidenceValue(entry, `${field}[${index}]`, depth + 1, seen, counter));
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw new Error("journey_evidence_payload_not_json");
  for (const [key, entry] of Object.entries(value)) {
    scanEvidenceString(key);
    if (isSensitiveField(key) && entry !== null && entry !== undefined) {
      throw new Error("journey_evidence_sensitive_content");
    }
    visitEvidenceValue(entry, `${field}.${key}`, depth + 1, seen, counter);
  }
  seen.delete(value);
}

function scanEvidenceString(value: string): void {
  if (value.length > MAX_STRING_LENGTH) throw new Error("journey_evidence_string_too_large");
  if (SENSITIVE_TEXT.some((pattern) => pattern.test(value))) throw new Error("journey_evidence_sensitive_content");
}

function validateReleaseIdentity(value: JourneyReleaseIdentity): JourneyReleaseIdentity {
  if (!isPlainObject(value)
    || !isBoundedIdentifier(value.releaseRunId, "release")
    || typeof value.nonce !== "string"
    || value.nonce.length < 16
    || value.nonce.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(value.nonce)) {
    throw new Error("journey_evidence_release_identity_invalid");
  }
  return Object.freeze({
    releaseRunId: value.releaseRunId,
    nonce: value.nonce,
    digests: normalizeDigests(value.digests),
  });
}

function normalizeDigests(value: JourneyEvidenceDigests): JourneyEvidenceDigests {
  if (!isPlainObject(value) || !hasOnlyKeys(value, DIGEST_FIELDS)) {
    throw new Error("journey_evidence_digests_invalid");
  }
  const normalized = {} as Record<(typeof DIGEST_FIELDS)[number], string>;
  for (const field of DIGEST_FIELDS) {
    const digest = value[field];
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error("journey_evidence_digests_invalid");
    }
    normalized[field] = digest;
  }
  return Object.freeze(normalized) as JourneyEvidenceDigests;
}

function validateCellIdentity(value: Readonly<{ bundleCellId: string; scenarioId: string }>): void {
  if (!isBoundedIdentifier(value.bundleCellId, "cell") || !isBoundedIdentifier(value.scenarioId, "scenario")) {
    throw new Error("journey_evidence_cell_identity_invalid");
  }
}

function normalizeLineage(value: JourneyEvidenceLineage): JourneyEvidenceLineage {
  if (!isPlainObject(value)
    || !hasOnlyKeys(value, ["runtimeInstanceId"])
    || typeof value.runtimeInstanceId !== "string"
    || value.runtimeInstanceId.length > 128
    || !/^runtime_instance_[A-Za-z0-9-]+$/.test(value.runtimeInstanceId)) {
    throw new Error("journey_evidence_lineage_invalid");
  }
  return Object.freeze({ runtimeInstanceId: value.runtimeInstanceId });
}

function validateStream(value: JourneyEvidenceStream): void {
  if (!isPlainObject(value)
    || !ISSUERS.has(value.issuer)
    || !EVIDENCE_CLASSES.has(value.evidenceClass)
    || !SURFACES.has(value.surface)) {
    throw new Error("journey_evidence_stream_invalid");
  }
  const profile = AUTHORITY_PROFILE[value.issuer];
  if (profile.evidenceClass !== value.evidenceClass || profile.surface !== value.surface) {
    throw new Error("journey_evidence_issuer_class_mismatch");
  }
}

function validateCellDeclaration(cell: JourneyEvidenceCellDeclaration): void {
  if (!isPlainObject(cell)
    || !hasOnlyKeys(cell, ["bundleCellId", "scenarioId", "lineage", "required", "streams"])
    || typeof cell.required !== "boolean"
    || !Array.isArray(cell.streams)
    || cell.streams.length === 0) {
    throw new Error("journey_evidence_matrix_cell_invalid");
  }
  validateCellIdentity(cell);
  normalizeLineage(cell.lineage);
  const streams = new Set<string>();
  for (const stream of cell.streams) {
    validateStream(stream);
    const key = streamKey(stream);
    if (streams.has(key)) throw new Error("journey_evidence_matrix_stream_duplicate");
    streams.add(key);
  }
}

function validateCellResult(result: JourneyEvidenceCellResult): void {
  if (!isPlainObject(result)
    || !hasOnlyKeys(result, [
      "journeyId", "releaseRunId", "nonce", "digests", "bundleCellId", "scenarioId", "lineage",
      "issuer", "evidenceClass", "surface", "outcome",
    ])
    || typeof result.journeyId !== "string"
    || result.journeyId.length > 128
    || !/^journey_[A-Za-z0-9-]+$/.test(result.journeyId)
    || !OUTCOMES.has(result.outcome)) {
    throw new Error("journey_evidence_result_invalid");
  }
  validateReleaseIdentity(result);
  validateCellIdentity(result);
  normalizeLineage(result.lineage);
  validateStream(result);
}

function serializeAuthority(authority: JourneyEvidenceAuthority): JourneyEvidenceAuthorityInput & JourneyEvidenceStream {
  return {
    ...releaseIdentityOf(authority),
    bundleCellId: authority.bundleCellId,
    scenarioId: authority.scenarioId,
    lineage: authority.lineage,
    issuer: authority.issuer,
    evidenceClass: authority.evidenceClass,
    surface: authority.surface,
  };
}

function assertEntryAuthority(entry: Readonly<Record<string, unknown>>, authority: JourneyEvidenceAuthority): void {
  const actual = {
    releaseRunId: entry.releaseRunId,
    nonce: entry.nonce,
    digests: entry.digests,
    bundleCellId: entry.bundleCellId,
    scenarioId: entry.scenarioId,
    lineage: entry.lineage,
    issuer: entry.issuer,
    evidenceClass: entry.evidenceClass,
    surface: entry.surface,
  };
  if (!isDeepStrictEqual(actual, serializeAuthority(authority))) throw new Error("journey_evidence_ledger_authority_mismatch");
}

function releaseIdentityOf(value: JourneyReleaseIdentity): JourneyReleaseIdentity {
  return {
    releaseRunId: value.releaseRunId,
    nonce: value.nonce,
    digests: value.digests,
  };
}

function cellKey(value: Readonly<{ bundleCellId: string; scenarioId: string }>): string {
  return `${value.bundleCellId}\0${value.scenarioId}`;
}

function streamKey(value: JourneyEvidenceStream): string {
  return `${value.issuer}\0${value.evidenceClass}\0${value.surface}`;
}

function isBoundedIdentifier(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && value.length <= 128
    && new RegExp(`^${prefix}_[A-Za-z0-9-]+$`).test(value);
}

function validateCheckpoint(checkpoint: JourneyCheckpoint): void {
  if (!isPlainObject(checkpoint)) throw new Error("journey_checkpoint_invalid");
  if (!hasOnlyKeys(checkpoint, ["checkpoint", "eventKind", "observedAt", "identities", "summary", "observation", "assertions"])) {
    throw new Error("journey_checkpoint_invalid");
  }
  if (!CHECKPOINTS.has(checkpoint.checkpoint)) throw new Error("journey_checkpoint_name_invalid");
  if (!EVENT_KINDS.has(checkpoint.eventKind)) throw new Error("journey_checkpoint_kind_invalid");
  if (!isCanonicalTimestamp(checkpoint.observedAt)) {
    throw new Error("journey_checkpoint_observed_at_invalid");
  }
  validateIdentities(checkpoint.identities);
  validateCheckpointSummary(checkpoint.summary);
  if (!isPlainObject(checkpoint.observation)) throw new Error("journey_checkpoint_observation_invalid");
  assertObservationIdentitySafety(checkpoint.observation);
  validateAssertions(checkpoint.assertions, "journey_checkpoint_assertions_required");
  assertEvidenceSafe(checkpoint);
}

function validateIdentities(identities: Readonly<Record<string, string>> | undefined): void {
  if (identities === undefined) return;
  if (!isPlainObject(identities)) throw new Error("journey_evidence_identity_not_aliased");
  for (const [field, identity] of Object.entries(identities)) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(field) || typeof identity !== "string") {
      throw new Error("journey_evidence_identity_not_aliased");
    }
    if (isAliasedNativeIdentity(identity)) continue;
    const expectedPrefix = PUBLIC_IDENTITY_FIELDS[field];
    if (!expectedPrefix || !isPublicRuntimeIdentity(identity, expectedPrefix)) {
      throw new Error("journey_evidence_identity_not_aliased");
    }
  }
}

function validateCheckpointSummary(summary: JourneyCheckpointSummary): void {
  if (!isPlainObject(summary)
    || !hasOnlyKeys(summary, ["durableWriter", "durableIdentity", "command", "externalEffect"])
    || !isNonEmptyString(summary.durableWriter)
    || !isSafeIdentity(summary.durableIdentity)
    || !isPlainObject(summary.command)
    || !hasOnlyKeys(summary.command, ["commandId", "idempotencyKey", "fence"])
    || !isPublicRuntimeIdentity(summary.command.commandId, "command")
    || !isAliasedNativeIdentity(summary.command.idempotencyKey)
    || !isNonEmptyString(summary.command.fence)
    || !isPlainObject(summary.externalEffect)
    || !hasOnlyKeys(summary.externalEffect, ["kind", "recovery", "effectIdentity"])
    || !isNonEmptyString(summary.externalEffect.kind)
    || !isNonEmptyString(summary.externalEffect.recovery)
    || (summary.externalEffect.effectIdentity !== undefined && !isSafeIdentity(summary.externalEffect.effectIdentity))) {
    throw new Error("journey_checkpoint_summary_invalid");
  }
}

function validateAssertions(assertions: readonly JourneyAssertion[], emptyCode: string): readonly JourneyAssertion[] {
  if (!Array.isArray(assertions) || assertions.length === 0) throw new Error(emptyCode);
  const ids = new Set<string>();
  for (const assertion of assertions) {
    if (!isPlainObject(assertion)
      || !hasOnlyKeys(assertion, ["id", "outcome", "required"])
      || !isNonEmptyString(assertion.id)
      || typeof assertion.outcome !== "string"
      || !OUTCOMES.has(assertion.outcome as JourneyOutcome)
      || (assertion.required !== undefined && typeof assertion.required !== "boolean")
      || ids.has(assertion.id)) {
      throw new Error("journey_evidence_assertion_invalid");
    }
    ids.add(assertion.id);
  }
  return assertions;
}

function assertObservationIdentitySafety(value: unknown, field?: string): void {
  if (field) {
    const expectedPrefix = PUBLIC_IDENTITY_FIELDS[field];
    if (expectedPrefix && typeof value !== "string") throw new Error("journey_evidence_observation_identity_invalid");
    if (isProviderNativeField(field) && !Array.isArray(value) && typeof value !== "string") {
      throw new Error("journey_evidence_observation_native_identity_not_aliased");
    }
    if (!expectedPrefix && !isProviderNativeField(field) && IDENTITY_LIKE_FIELD.test(field) && typeof value !== "string") {
      throw new Error("journey_evidence_observation_identity_field_not_allowlisted");
    }
  }
  if (typeof value === "string") {
    if (!field) return;
    const expectedPrefix = PUBLIC_IDENTITY_FIELDS[field];
    if (expectedPrefix) {
      if (!isPublicRuntimeIdentity(value, expectedPrefix)) throw new Error("journey_evidence_observation_identity_invalid");
      return;
    }
    if (isProviderNativeField(field)) {
      if (!isAliasedNativeIdentity(value)) throw new Error("journey_evidence_observation_native_identity_not_aliased");
      return;
    }
    if (IDENTITY_LIKE_FIELD.test(field)) {
      throw new Error("journey_evidence_observation_identity_field_not_allowlisted");
    }
    if (SEMANTIC_OBSERVATION_FIELDS.has(field)) {
      if (PROVIDER_NATIVE_ENTROPIC_VALUE.test(value)) {
        throw new Error("journey_evidence_observation_native_identity_not_aliased");
      }
      return;
    }
    if (!isAliasedNativeIdentity(value)
      && !isPublicRuntimeIdentity(value)
      && PROVIDER_NATIVE_VALUE.test(value)) {
      throw new Error("journey_evidence_observation_native_identity_not_aliased");
    }
    if (isPublicRuntimeIdentity(value)) throw new Error("journey_evidence_observation_identity_field_not_allowlisted");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertObservationIdentitySafety(entry, field));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) assertObservationIdentitySafety(entry, key);
}

function isRequired(assertion: JourneyAssertion): boolean {
  return assertion.required !== false;
}

function isSensitiveField(field: string): boolean {
  const normalized = field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_").toLowerCase();
  if (normalized.startsWith("has_") || normalized.startsWith("is_")) return false;
  return SENSITIVE_FIELD.test(normalized);
}

function isProviderNativeField(field: string): boolean {
  const normalized = field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (normalized === "native" || normalized.startsWith("native_")) return true;
  if (["thread", "thread_id", "thread_ids", "session", "session_id", "session_ids", "conversation", "conversation_id", "conversation_ids", "chat_id", "response_id"].includes(normalized)) return true;
  return normalized.startsWith("provider_")
    && ["native", "thread", "session", "conversation", "response", "run"].some((part) => normalized.includes(part));
}

function isAliasedNativeIdentity(value: string): boolean {
  return /^alias_[a-z][a-z0-9_]*_[a-f0-9]{20}$/.test(value);
}

function isPublicRuntimeIdentity(value: unknown, expectedPrefix?: string): value is string {
  if (typeof value !== "string") return false;
  const match = /^([a-z][a-z0-9_]*?)_([A-Za-z0-9-]+)$/.exec(value);
  if (!match?.[1] || !PUBLIC_RUNTIME_ID_PREFIXES.has(match[1] as never)) return false;
  return expectedPrefix === undefined || match[1] === expectedPrefix;
}

function isSafeIdentity(value: unknown): value is string {
  return typeof value === "string" && (isAliasedNativeIdentity(value) || isPublicRuntimeIdentity(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_STRING_LENGTH;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function writePrivateJson(file: string, value: unknown, flag: "w" | "wx" = "w"): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag });
  await chmod(file, 0o600);
}

async function writePrivateBytes(file: string, value: Uint8Array, flag: "w" | "wx" = "w"): Promise<void> {
  await writeFile(file, value, { mode: 0o600, flag });
  await chmod(file, 0o600);
}

async function writeChecksums(root: string): Promise<void> {
  await enforcePrivatePermissions(root);
  const files = (await listFiles(root)).filter((file) => path.basename(file) !== CHECKSUMS_FILE).sort();
  const checksums = await Promise.all(files.map(async (file) => {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    return `${digest}  ${path.relative(root, file).replaceAll(path.sep, "/")}`;
  }));
  await writeFile(path.join(root, CHECKSUMS_FILE), `${checksums.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path.join(root, CHECKSUMS_FILE), 0o600);
}

async function verifyChecksums(root: string): Promise<void> {
  const source = await readFile(path.join(root, CHECKSUMS_FILE), "utf8");
  const expected = new Map<string, string>();
  for (const line of source.split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([^\0]+)$/.exec(line);
    if (!match?.[1] || !match[2] || path.isAbsolute(match[2]) || match[2].split("/").includes("..")) {
      throw new Error("journey_evidence_checksum_invalid");
    }
    expected.set(match[2], match[1]);
  }
  const actualFiles = (await listFiles(root)).filter((file) => path.basename(file) !== CHECKSUMS_FILE).sort();
  const actualNames = actualFiles.map((file) => path.relative(root, file).replaceAll(path.sep, "/"));
  if (!isDeepStrictEqual([...expected.keys()].sort(), [...actualNames].sort())) throw new Error("journey_evidence_checksum_invalid");
  for (const [index, file] of actualFiles.entries()) {
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    if (expected.get(actualNames[index]!) !== digest) throw new Error("journey_evidence_checksum_invalid");
  }
  await enforcePrivatePermissions(root);
  await chmod(path.join(root, CHECKSUMS_FILE), 0o600);
}

async function enforcePrivatePermissions(root: string): Promise<void> {
  await chmod(root, 0o700);
  await walkBundle(root, async (absolute, kind) => {
    await chmod(absolute, kind === "directory" ? 0o700 : 0o600);
  });
}

async function listFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  await walkBundle(root, async (absolute, kind) => {
    if (kind === "file") files.push(absolute);
  });
  return files;
}

async function walkBundle(
  root: string,
  visit: (absolute: string, kind: "directory" | "file") => Promise<void>,
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("journey_evidence_bundle_symlink_unsafe");
    if (entry.isDirectory()) {
      await visit(absolute, "directory");
      await walkBundle(absolute, visit);
    } else if (entry.isFile()) {
      await visit(absolute, "file");
    } else {
      throw new Error("journey_evidence_bundle_entry_unsafe");
    }
  }
}

async function assertSafeDirectory(directory: string, code: string): Promise<void> {
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(code);
}

async function requireRegularFile(file: string, code: string): Promise<void> {
  const status = await lstatOrUndefined(file);
  if (!status?.isFile() || status.isSymbolicLink()) throw new Error(code);
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  const status = await lstatOrUndefined(file);
  if (!status) return undefined;
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("journey_evidence_manifest_invalid");
  const bytes = await readFile(file);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("journey_evidence_manifest_invalid");
  }
}

async function readFileOrUndefined(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function lstatOrUndefined(file: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function fileExists(file: string): Promise<boolean> {
  return (await lstatOrUndefined(file)) !== undefined;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export async function evidencePermissions(file: string): Promise<number> {
  return (await stat(file)).mode & 0o777;
}
