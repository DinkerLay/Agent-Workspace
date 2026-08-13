import {
  hashDefinition,
  validateTaskArchitectureSnapshotV3,
  type JsonValue,
  type TaskArchitectureSnapshotV3,
  type TaskRecord,
  type TaskRunRecord,
  type WorkspaceAuthorizationRecord,
  type WorkspaceEffectIntentRecord,
  type WorkspaceFileObservationRecord,
  type WorkspaceReferenceV3,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "@agent-workspace/runtime-domain";
import type { SessionIdUiCommandReceiptRecord } from "@agent-workspace/runtime-store";

export type SessionIdAcpWorkspacePreviewCommand = Readonly<{
  type: "workspace.preview_file";
  commandId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  observationId: string;
  issuedAt: string;
}>;

export type SessionIdAcpWorkspacePreviewObservation = Readonly<{
  observationId: string;
  workspaceRelativePath: string;
  observedAt: string;
  contentDigest?: string;
  currentState: WorkspaceFileObservationRecord["state"];
  source: WorkspaceFileObservationRecord["source"];
}>;

export type SessionIdAcpWorkspacePreviewResult = Readonly<{
  filePreview: Readonly<{
    observation: SessionIdAcpWorkspacePreviewObservation;
    content?: string;
  }>;
}>;

/**
 * A physical read result from the trusted Runtime Host. `changed` is derived
 * by the application against the selected durable observation, never asserted
 * by the filesystem port.
 */
export type SessionIdAcpWorkspacePreviewFileState = Readonly<{
  state: "available" | "missing" | "too_large" | "unsupported";
  contentDigest?: string;
  byteLength?: number;
  content?: string;
}>;

export type SessionIdAcpWorkspacePreviewRevalidateInput = Readonly<{
  workspace: WorkspaceReferenceV3;
  authorization: WorkspaceAuthorizationRecord;
  workspaceRelativePath: string;
}>;

export interface SessionIdAcpWorkspacePreviewTemplateTaskCapability {
  getTask(taskId: string): TaskRecord | undefined;
  getRun(runId: string): TaskRunRecord | undefined;
  getArchitectureSnapshot(taskId: string): unknown;
}

export interface SessionIdAcpWorkspacePreviewAuthorizationCapability {
  getAuthorization(workspaceId: string): WorkspaceAuthorizationRecord | undefined;
}

export interface SessionIdAcpWorkspacePreviewWorkspaceCapability {
  getObservation(workspaceFileObservationId: string): WorkspaceFileObservationRecord | undefined;
  listObservations(taskId: string): readonly WorkspaceFileObservationRecord[];
  findEffectIntentByObservationId(
    taskId: string,
    workspaceFileObservationId: string,
  ): WorkspaceEffectIntentRecord | undefined;
  createObservation(observation: WorkspaceFileObservationRecord, workspaceEffectIntentId?: string): void;
}

export interface SessionIdAcpWorkspacePreviewReceiptCapability {
  getUiCommandReceipt(taskId: string, commandId: string): SessionIdUiCommandReceiptRecord | undefined;
  createUiCommandReceipt(receipt: SessionIdUiCommandReceiptRecord): void;
}

export type SessionIdAcpWorkspacePreviewCapabilities = Readonly<{
  templateTask: SessionIdAcpWorkspacePreviewTemplateTaskCapability;
  authorizations: SessionIdAcpWorkspacePreviewAuthorizationCapability;
  workspace: SessionIdAcpWorkspacePreviewWorkspaceCapability;
  commandReceipts: SessionIdAcpWorkspacePreviewReceiptCapability;
}>;

export type SessionIdAcpWorkspacePreviewOwnerOptions = Readonly<{
  now(): string;
  createId(kind: "workspace_file_observation"): string;
  /** Both methods must be backed by the same SQLite instance in production. */
  transaction: Readonly<{
    read<T>(work: (owners: SessionIdAcpWorkspacePreviewCapabilities) => T): T;
    run<T>(work: (owners: SessionIdAcpWorkspacePreviewCapabilities) => T): T;
  }>;
  revalidator: Readonly<{
    revalidate(input: SessionIdAcpWorkspacePreviewRevalidateInput): Promise<SessionIdAcpWorkspacePreviewFileState>;
  }>;
}>;

type PreviewScope = Readonly<{
  task: TaskRecord;
  run: TaskRunRecord;
  architecture: TaskArchitectureSnapshotV3;
  authorization: WorkspaceAuthorizationRecord;
  source: WorkspaceFileObservationRecord;
  sourceEffectIntentId?: string;
  sourceEffectContentDigest?: string;
  proof: string;
}>;

type PreviewPreflight =
  | Readonly<{ kind: "replay"; result: SessionIdAcpWorkspacePreviewResult }>
  | Readonly<{ kind: "ready"; scope: PreviewScope }>;

/**
 * ACP-only Workspace Preview command owner.
 *
 * The external operation is a bounded filesystem read, not a Workspace write
 * effect. A new human-only observation is therefore written only when the
 * revalidated file state differs from the current observation. Verified-tool
 * provenance is retained by linking the derived observation to the original
 * Workspace effect; no Provider or Binding identity enters the public result.
 */
export function createSessionIdAcpWorkspacePreviewOwner(options: SessionIdAcpWorkspacePreviewOwnerOptions) {
  validateOptions(options);
  return Object.freeze({ command });

  async function command(value: SessionIdAcpWorkspacePreviewCommand): Promise<SessionIdAcpWorkspacePreviewResult> {
    const input = exactCommand(value);
    const payloadFingerprint = commandFingerprint(input);
    const preflight = options.transaction.read((owners) => {
      const replay = readReplay(owners.commandReceipts, input, payloadFingerprint);
      if (replay) return Object.freeze({ kind: "replay" as const, result: replay });
      return Object.freeze({ kind: "ready" as const, scope: readScope(owners, input) });
    }) satisfies PreviewPreflight;
    if (preflight.kind === "replay") return preflight.result;

    const physical = exactFileState(await options.revalidator.revalidate(Object.freeze({
      workspace: preflight.scope.architecture.workspace,
      authorization: preflight.scope.authorization,
      workspaceRelativePath: preflight.scope.source.workspaceRelativePath,
    })));

    return options.transaction.run((owners) => {
      const racedReplay = readReplay(owners.commandReceipts, input, payloadFingerprint);
      if (racedReplay) return racedReplay;
      const current = readScope(owners, input);
      invariant(current.proof === preflight.scope.proof, "acp_workspace_preview_scope_changed");
      const committedAt = exactTimestamp(options.now(), "acp_workspace_preview_clock_invalid");
      const next = observationState(current.source, physical, committedAt, current.sourceEffectContentDigest);
      const changed = !sameObservedState(current.source, next);
      const observation = changed
        ? Object.freeze({
          ...next,
          workspaceFileObservationId: exactId(
            options.createId("workspace_file_observation"),
            "workspace_file_observation",
            "acp_workspace_preview_observation_id_invalid",
          ),
        })
        : current.source;
      if (changed) {
        invariant(!owners.workspace.getObservation(observation.workspaceFileObservationId),
          "acp_workspace_preview_observation_id_conflict");
        owners.workspace.createObservation(observation, current.sourceEffectIntentId);
      }
      const result = publicResult(observation, physical.content);
      owners.commandReceipts.createUiCommandReceipt(Object.freeze({
        commandId: input.commandId,
        taskId: input.taskId,
        runId: input.runId,
        commandKind: "workspace.preview_file",
        idempotencyKey: input.commandId,
        payloadFingerprint,
        result: result as unknown as JsonValue,
        createdAt: committedAt,
      }));
      return result;
    });
  }
}

function readScope(
  owners: SessionIdAcpWorkspacePreviewCapabilities,
  command: SessionIdAcpWorkspacePreviewCommand,
): PreviewScope {
  const task = owners.templateTask.getTask(command.taskId);
  invariant(Boolean(task)
    && task!.taskId === command.taskId
    && task!.activeRunId === command.runId,
  "acp_workspace_preview_task_run_scope_mismatch");
  invariant(task!.revision === command.expectedRevision, "acp_workspace_preview_task_revision_stale");
  const run = owners.templateTask.getRun(command.runId);
  invariant(Boolean(run) && run!.taskId === command.taskId && run!.runId === command.runId,
    "acp_workspace_preview_task_run_scope_mismatch");
  const architecture = validateTaskArchitectureSnapshotV3(
    owners.templateTask.getArchitectureSnapshot(command.taskId),
  );
  invariant(architecture.taskId === command.taskId
    && architecture.architectureSnapshotId === task!.architectureSnapshotId,
  "acp_workspace_preview_architecture_scope_mismatch");
  const authorization = owners.authorizations.getAuthorization(architecture.workspace.workspaceId);
  invariant(Boolean(authorization)
    && authorization!.workspaceId === architecture.workspace.workspaceId,
  "acp_workspace_preview_authorization_not_found");
  exactAuthorization(authorization!);
  const source = owners.workspace.getObservation(command.observationId);
  invariant(Boolean(source)
    && source!.workspaceFileObservationId === command.observationId
    && source!.taskId === command.taskId
    && (!source!.runId || source!.runId === command.runId),
  "acp_workspace_preview_observation_not_found");
  exactObservation(source!);
  const latest = latestObservationForPath(
    owners.workspace.listObservations(command.taskId),
    command.taskId,
    command.runId,
    source!.workspaceRelativePath,
  );
  invariant(latest?.workspaceFileObservationId === source!.workspaceFileObservationId,
    "acp_workspace_preview_observation_not_current");
  const sourceEffect = source!.source === "verified_tool"
    ? owners.workspace.findEffectIntentByObservationId(command.taskId, source!.workspaceFileObservationId)
    : undefined;
  if (source!.source === "verified_tool") {
    invariant(Boolean(sourceEffect)
      && sourceEffect!.taskId === command.taskId
      && sourceEffect!.runId === command.runId
      && sourceEffect!.workspaceRelativePath === source!.workspaceRelativePath
      && sourceEffect!.state === "applied",
    "acp_workspace_preview_verified_effect_missing");
  }
  const proof = hashDefinition({
    task: task as unknown as JsonValue,
    run: run as unknown as JsonValue,
    architecture: architecture as unknown as JsonValue,
    authorization: authorization as unknown as JsonValue,
    source: source as unknown as JsonValue,
    sourceEffectIntentId: sourceEffect?.workspaceEffectIntentId ?? null,
  });
  return Object.freeze({
    task: task!,
    run: run!,
    architecture,
    authorization: authorization!,
    source: source!,
    ...(sourceEffect ? { sourceEffectIntentId: sourceEffect.workspaceEffectIntentId } : {}),
    ...(sourceEffect ? { sourceEffectContentDigest: sourceEffect.contentDigest } : {}),
    proof,
  });
}

function readReplay(
  receipts: SessionIdAcpWorkspacePreviewReceiptCapability,
  command: SessionIdAcpWorkspacePreviewCommand,
  payloadFingerprint: string,
): SessionIdAcpWorkspacePreviewResult | undefined {
  const receipt = receipts.getUiCommandReceipt(command.taskId, command.commandId);
  if (!receipt) return undefined;
  invariant(receipt.commandKind === "workspace.preview_file"
    && receipt.taskId === command.taskId
    && receipt.runId === command.runId
    && receipt.idempotencyKey === command.commandId
    && receipt.payloadFingerprint === payloadFingerprint,
  "acp_workspace_preview_command_replay_conflict");
  return exactPublicResult(receipt.result);
}

function observationState(
  source: WorkspaceFileObservationRecord,
  physical: SessionIdAcpWorkspacePreviewFileState,
  observedAt: string,
  verifiedEffectDigest?: string,
): Omit<WorkspaceFileObservationRecord, "workspaceFileObservationId"> {
  const common = {
    taskId: source.taskId,
    ...(source.runId ? { runId: source.runId } : {}),
    workspaceRelativePath: source.workspaceRelativePath,
    source: source.source,
    observedAt,
  } as const;
  if (physical.state === "available") {
    const state = verifiedEffectDigest
      ? (verifiedEffectDigest === physical.contentDigest ? "available" as const : "changed" as const)
      : source.state === "changed" && source.contentDigest === physical.contentDigest
        ? "changed" as const
        : source.contentDigest && source.contentDigest !== physical.contentDigest
          ? "changed" as const
          : "available" as const;
    return Object.freeze({
      ...common,
      contentDigest: physical.contentDigest!,
      byteLength: physical.byteLength!,
      state,
    });
  }
  return Object.freeze({
    ...common,
    ...(physical.byteLength === undefined ? {} : { byteLength: physical.byteLength }),
    state: physical.state,
  });
}

function sameObservedState(
  left: WorkspaceFileObservationRecord,
  right: Omit<WorkspaceFileObservationRecord, "workspaceFileObservationId">,
): boolean {
  return left.state === right.state
    && left.contentDigest === right.contentDigest
    && left.byteLength === right.byteLength;
}

function publicResult(
  observation: WorkspaceFileObservationRecord,
  content: string | undefined,
): SessionIdAcpWorkspacePreviewResult {
  return Object.freeze({
    filePreview: Object.freeze({
      observation: Object.freeze({
        observationId: observation.workspaceFileObservationId,
        workspaceRelativePath: observation.workspaceRelativePath,
        observedAt: observation.observedAt,
        ...(observation.contentDigest ? { contentDigest: observation.contentDigest } : {}),
        currentState: observation.state,
        source: observation.source,
      }),
      ...(content === undefined ? {} : { content }),
    }),
  });
}

function exactPublicResult(value: JsonValue): SessionIdAcpWorkspacePreviewResult {
  const root = exactRecord(value, ["filePreview"], "acp_workspace_preview_receipt_invalid");
  const preview = exactRecord(root.filePreview, ["observation", "content"], "acp_workspace_preview_receipt_invalid", true);
  const observation = exactRecord(
    preview.observation,
    ["observationId", "workspaceRelativePath", "observedAt", "contentDigest", "currentState", "source"],
    "acp_workspace_preview_receipt_invalid",
    true,
  );
  const state = observation.currentState;
  const source = observation.source;
  invariant(state === "available" || state === "missing" || state === "changed"
    || state === "too_large" || state === "unsupported",
  "acp_workspace_preview_receipt_invalid");
  invariant(source === "verified_tool" || source === "unverified", "acp_workspace_preview_receipt_invalid");
  const contentDigest = observation.contentDigest === undefined
    ? undefined
    : exactDigest(observation.contentDigest, "acp_workspace_preview_receipt_invalid");
  const content = preview.content === undefined
    ? undefined
    : exactBoundedText(preview.content, 1_048_576, "acp_workspace_preview_receipt_invalid");
  return Object.freeze({
    filePreview: Object.freeze({
      observation: Object.freeze({
        observationId: exactId(observation.observationId, "workspace_file_observation", "acp_workspace_preview_receipt_invalid"),
        workspaceRelativePath: exactRelativePath(observation.workspaceRelativePath),
        observedAt: exactTimestamp(observation.observedAt, "acp_workspace_preview_receipt_invalid"),
        ...(contentDigest ? { contentDigest } : {}),
        currentState: state,
        source,
      }),
      ...(content === undefined ? {} : { content }),
    }),
  });
}

function exactFileState(value: SessionIdAcpWorkspacePreviewFileState): SessionIdAcpWorkspacePreviewFileState {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "acp_workspace_preview_file_state_invalid");
  const record = value as Record<string, unknown>;
  const state = record.state;
  invariant(state === "available" || state === "missing" || state === "too_large" || state === "unsupported",
    "acp_workspace_preview_file_state_invalid");
  if (state === "available") {
    exactKeys(record, ["state", "contentDigest", "byteLength", "content"], "acp_workspace_preview_file_state_invalid");
    const content = exactBoundedText(record.content, 1_048_576, "acp_workspace_preview_file_state_invalid", true);
    const byteLength = exactByteLength(record.byteLength);
    invariant(new TextEncoder().encode(content).byteLength === byteLength, "acp_workspace_preview_file_state_invalid");
    return Object.freeze({
      state,
      contentDigest: exactDigest(record.contentDigest, "acp_workspace_preview_file_state_invalid"),
      byteLength,
      content,
    });
  }
  if (state === "missing") {
    exactKeys(record, ["state"], "acp_workspace_preview_file_state_invalid");
    return Object.freeze({ state });
  }
  exactKeys(record, ["state", "byteLength"], "acp_workspace_preview_file_state_invalid", state === "unsupported");
  return Object.freeze({
    state,
    ...(record.byteLength === undefined ? {} : { byteLength: exactByteLength(record.byteLength) }),
  });
}

function latestObservationForPath(
  observations: readonly WorkspaceFileObservationRecord[],
  taskId: string,
  runId: string,
  workspaceRelativePath: string,
): WorkspaceFileObservationRecord | undefined {
  return observations
    .filter((observation) => observation.taskId === taskId
      && (!observation.runId || observation.runId === runId)
      && observation.workspaceRelativePath === workspaceRelativePath)
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt)
      || right.workspaceFileObservationId.localeCompare(left.workspaceFileObservationId))[0];
}

function exactCommand(value: SessionIdAcpWorkspacePreviewCommand): SessionIdAcpWorkspacePreviewCommand {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    "acp_workspace_preview_command_shape_invalid");
  exactKeys(value as unknown as Record<string, unknown>, [
    "type", "commandId", "taskId", "runId", "expectedRevision", "observationId", "issuedAt",
  ], "acp_workspace_preview_command_shape_invalid");
  invariant(value.type === "workspace.preview_file", "acp_workspace_preview_command_shape_invalid");
  invariant(Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 1,
    "acp_workspace_preview_command_shape_invalid");
  return Object.freeze({
    type: value.type,
    commandId: exactId(value.commandId, "command", "acp_workspace_preview_command_shape_invalid"),
    taskId: exactId(value.taskId, "task", "acp_workspace_preview_command_shape_invalid"),
    runId: exactId(value.runId, "run", "acp_workspace_preview_command_shape_invalid"),
    expectedRevision: value.expectedRevision,
    observationId: exactId(value.observationId, "workspace_file_observation", "acp_workspace_preview_command_shape_invalid"),
    issuedAt: exactTimestamp(value.issuedAt, "acp_workspace_preview_command_shape_invalid"),
  });
}

function commandFingerprint(command: SessionIdAcpWorkspacePreviewCommand): string {
  return hashDefinition({
    type: command.type,
    taskId: command.taskId,
    runId: command.runId,
    expectedRevision: command.expectedRevision,
    observationId: command.observationId,
    issuedAt: command.issuedAt,
  });
}

function exactObservation(observation: WorkspaceFileObservationRecord): void {
  exactRelativePath(observation.workspaceRelativePath);
  exactTimestamp(observation.observedAt, "acp_workspace_preview_observation_invalid");
  if (observation.contentDigest !== undefined) exactDigest(observation.contentDigest, "acp_workspace_preview_observation_invalid");
  if (observation.byteLength !== undefined) exactByteLength(observation.byteLength);
  invariant(observation.state === "available" || observation.state === "missing" || observation.state === "changed"
    || observation.state === "too_large" || observation.state === "unsupported",
  "acp_workspace_preview_observation_invalid");
  invariant(observation.source === "verified_tool" || observation.source === "unverified",
    "acp_workspace_preview_observation_invalid");
}

function exactAuthorization(authorization: WorkspaceAuthorizationRecord): void {
  exactId(authorization.workspaceId, "workspace", "acp_workspace_preview_authorization_invalid");
  exactBoundedText(authorization.canonicalDirectory, 16_384, "acp_workspace_preview_authorization_invalid");
  exactBoundedText(authorization.displayName, 1_000, "acp_workspace_preview_authorization_invalid");
  exactTimestamp(authorization.authorizedAt, "acp_workspace_preview_authorization_invalid");
}

function exactRelativePath(value: unknown): string {
  const path = exactBoundedText(value, 512, "acp_workspace_preview_path_invalid").normalize("NFC");
  const segments = path.split("/");
  invariant(path === path.trim()
    && !path.startsWith("/")
    && !/^[a-zA-Z]:\//u.test(path)
    && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/u.test(path)
    && segments.every((segment) => Boolean(segment) && segment !== "." && segment !== ".."),
  "acp_workspace_preview_path_invalid");
  return path;
}

function exactId(value: unknown, prefix: string, code: string): string {
  const id = exactBoundedText(value, 512, code);
  invariant(id.startsWith(`${prefix}_`) && !/[\u0000-\u0020\u007f]/u.test(id), code);
  return id;
}

function exactDigest(value: unknown, code: string): string {
  invariant(typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value), code);
  return value;
}

function exactByteLength(value: unknown): number {
  invariant(Number.isSafeInteger(value) && (value as number) >= 0, "acp_workspace_preview_file_state_invalid");
  return value as number;
}

function exactTimestamp(value: unknown, code: string): string {
  invariant(typeof value === "string" && value.length <= 64, code);
  const parsed = new Date(value);
  invariant(Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value, code);
  return value;
}

function exactBoundedText(value: unknown, maximum: number, code: string, allowEmpty = false): string {
  invariant(typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0), code);
  return value;
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: string,
  optionalKeys = false,
): Record<string, unknown> {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value), code);
  const record = value as Record<string, unknown>;
  exactKeys(record, allowedKeys, code, optionalKeys);
  return record;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], code: string, optional = false): void {
  const actual = Object.keys(record).sort();
  const allowed = [...keys].sort();
  invariant(actual.every((key) => allowed.includes(key))
    && (optional || actual.length === allowed.length), code);
}

function validateOptions(options: SessionIdAcpWorkspacePreviewOwnerOptions): void {
  invariant(Boolean(options)
    && typeof options.now === "function"
    && typeof options.createId === "function"
    && typeof options.transaction?.read === "function"
    && typeof options.transaction?.run === "function"
    && typeof options.revalidator?.revalidate === "function",
  "acp_workspace_preview_owner_options_invalid");
}
