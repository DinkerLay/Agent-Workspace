import {
  decodeTemplateAssetTransports,
  encodeTemplateAssetTransports,
  hashDefinition,
  isMetaProfileDefinitionV3,
  isTaskArchitectureSnapshotV3,
  isTemplateDefinitionV3,
  type CardSessionSlotRecord,
  type AcpSafeSessionBindingRecordV3,
  type JsonValue,
  type LogicalSessionId,
  type MetaMessageRecord,
  type MetaPatchProposalRecord,
  type MetaPatchProposalRecordV3,
  type MetaProfileOptionDefinitionV3,
  type MetaProfileOptionSnapshot,
  type MetaProfileSnapshot,
  type MetaSessionRecord,
  type MetaSessionRecordV3,
  type RuntimeCommand,
  type RuntimeCommandReceipt,
  type RuntimeCommandResult,
  type TaskArchitectureSnapshot,
  type TaskRecord,
  type TaskRunRecord,
  type TaskSetupDraftRecord,
  type TemplateDraftRecord,
  type TemplateDefinition,
  type TemplateDefinitionV3,
  type TemplateAssetRecord,
  type TemplateAssetTransport,
  type TemplatePackage,
  type TemplatePackageSnapshot,
  type TemplateRecord,
  type TemplateVersionRecord,
  type WorkspaceAuthorizationRecord,
  type WorkspaceReferenceV3,
  validateTemplateArchivePayload,
  validateMetaProfileOptionDefinitionV3,
  validateTemplateDefinitionV3,
  validateTemplatePackage,
} from "@agent-workspace/runtime-contracts";
import {
  abandonMetaSession,
  abandonTaskSetupDraft,
  achieveTask,
  archiveTask,
  archiveTemplate,
  appendMetaMessage,
  applyMetaPatchProposalToTaskSetup,
  applyMetaPatchProposalToTemplateDraft,
  assertTaskNotTrashed,
  assertTaskSetupReadyForCreate,
  compileTaskGoal,
  consumeMetaSession,
  consumeTaskSetupDraft,
  createMetaSessionV3,
  createTask,
  createTaskArchitectureSnapshot,
  createTaskArchitectureSnapshotV3,
  createTaskSetupDraft,
  createTemplateDraft,
  createTemplateIdentity,
  createWorkspaceAuthorization,
  markTaskRunRunning,
  META_AGENT_OUTPUT_SCHEMA,
  publishTemplateDraft,
  rejectMetaPatchProposal,
  restartTaskRun,
  restoreTask,
  saveTaskSetupDraft,
  saveTemplateDraft,
  startTaskRun,
  TASK_GOAL_COMPILER_VERSION,
  templateVersionToPackage,
} from "@agent-workspace/runtime-domain";
import type {
  CommandStore,
  ConfigurationStore,
  AcpMetaTurnRecordV3,
  AcpTemplateV3DraftMigrationRepository,
  SessionIdTaskPermanentDeletePreview,
  SessionIdTaskPermanentDeleteResult,
  SessionIdTaskRetentionStore,
  SessionIdTaskRunStore,
  SessionIdWorkspaceStore,
  TemplateTaskStore,
  WorkspaceAuthorizationStore,
} from "@agent-workspace/runtime-store";
import type { SessionIdOrchestrationTaskScope } from "./session-id-orchestration-application.js";
import { acpMetaProfileIdentity } from "./meta-agent.js";
import {
  validateSessionIdAcpTaskLifecyclePreparedResult,
  type SessionIdAcpTaskCommandFence,
  type SessionIdAcpTaskLifecycleOwnerCapabilities,
  type SessionIdAcpTaskLifecyclePort,
  type SessionIdAcpTaskLifecyclePreparedResult,
} from "./session-id-acp-task-lifecycle.js";

type SupportedCommandType =
  | "workspace.authorize"
  | "template.create_draft"
  | "template.save_draft"
  | "template.migrate_v2_to_v3_draft"
  | "template.publish_draft"
  | "template.archive"
  | "template.import"
  | "template.export"
  | "task_setup.create_draft"
  | "task_setup.save_draft"
  | "task_setup.abandon_draft"
  | "meta.create_session"
  | "meta.send_message"
  | "meta.abandon_session"
  | "meta.apply_patch"
  | "meta.reject_patch"
  | "task.create"
  | "task.start"
  | "task.resume"
  | "task.restart";

export type SessionIdAchieveTaskCommand = Readonly<{
  type: "task.achieve";
  commandId: string;
  issuedAt: string;
  taskId: string;
  expectedRevision: number;
  /** Runtime resolves path/digest from this canonical observation identity. */
  fileStateAnchor?: Readonly<{ observationId: string; label?: string }>;
  acceptanceNote?: string;
}>;

type SessionIdTaskRetentionCommandBase = Readonly<{
  commandId: string;
  issuedAt: string;
  taskId: string;
  expectedRevision: number;
}>;

export type SessionIdTaskRetentionCommand =
  | (SessionIdTaskRetentionCommandBase & Readonly<{ type: "task.archive" }>)
  | (SessionIdTaskRetentionCommandBase & Readonly<{ type: "task.restore" }>)
  | (SessionIdTaskRetentionCommandBase & Readonly<{ type: "task.preview_permanent_delete" }>)
  | (SessionIdTaskRetentionCommandBase & Readonly<{ type: "task.permanently_delete" }>);

export type SessionIdConfigurationTaskLifecycleCommand =
  | Extract<RuntimeCommand, { type: SupportedCommandType }>
  | SessionIdAchieveTaskCommand
  | SessionIdTaskRetentionCommand;

export type SessionIdTaskRecord = Omit<TaskRecord, "achievement"> & Readonly<{
  achievement?: Readonly<{
    achievedAt: string;
    fileStateAnchor?: Readonly<{
      workspaceRelativePath: string;
      observedDigest: string;
      label?: string;
    }>;
    acceptanceNote?: string;
  }>;
}>;

export type SessionIdConfigurationTaskLifecycleResult = Readonly<{
  receipt: RuntimeCommandReceipt;
  task?: SessionIdTaskRecord;
  run?: TaskRunRecord;
  taskSetupDraft?: TaskSetupDraftRecord;
  metaSession?: MetaSessionRecord;
  metaMessage?: MetaMessageRecord;
  metaPatchProposal?: MetaPatchProposalRecord;
  templateDraft?: TemplateDraftRecord;
  template?: TemplateRecord;
  templateVersion?: TemplateVersionRecord;
  templatePackage?: TemplatePackageSnapshot;
  templateAssets?: readonly TemplateAssetTransport[];
  acpTaskRuntime?: SessionIdAcpTaskLifecyclePreparedResult;
  permanentDeletePreview?: SessionIdTaskPermanentDeletePreview;
  permanentDelete?: SessionIdTaskPermanentDeleteResult;
}>;

export type SessionIdConfigurationTaskLifecycleReadModel = Readonly<{
  configuration: Readonly<{
    templateDrafts: readonly TemplateDraftRecord[];
    taskSetupDrafts: readonly TaskSetupDraftRecord[];
    metaSessions: readonly MetaSessionRecord[];
    metaMessages: readonly MetaMessageRecord[];
    metaPatchProposals: readonly MetaPatchProposalRecord[];
  }>;
  templateLibrary: readonly Readonly<{
    template: TemplateRecord;
    activeVersion?: TemplateVersionRecord;
  }>[];
  taskSetupOptions: Readonly<{
    templates: readonly Readonly<{
      templateId: string;
      title: string;
      versions: readonly Readonly<{ templateVersionId: string; version: number }>[];
    }>[];
    workspaces: readonly Readonly<{ workspaceId: string; displayName: string }>[];
  }>;
  taskLibrary: readonly SessionIdTaskRecord[];
  currentTask?: Readonly<{
    task: SessionIdTaskRecord;
    activeRun?: TaskRunRecord;
    conductorSessionId?: LogicalSessionId;
    conductorBinding?: Readonly<{
      bindingId: string;
      sessionId: string;
      executionProfileId: string;
      provider: string;
      status: string;
      recoverable: boolean;
      revision: number;
    }>;
    lifecycle: Readonly<{
      canResume: boolean;
      resumeBlockedReason?: string;
      canRestart: boolean;
      restartBlockedReason?: string;
    }>;
    directory: readonly Readonly<{
      agentCardId: string;
      title: string;
      currentSessionId?: string;
      latestGeneration: number;
    }>[];
  }>;
}>;

export type SessionIdConductorLane = Readonly<{
  enqueueTaskGoal(input: Readonly<{ messageId: string; content: string }>): Readonly<{ status: "enqueued" }>;
}>;

export type SessionIdConfigurationTaskLifecycleOptions = Readonly<{
  now: () => string;
  createId: (kind: string) => string;
  transaction: <T>(work: () => T) => T;
  templates: Pick<TemplateTaskStore,
    | "createDraft" | "getDraft" | "listDrafts" | "updateDraft" | "publishDraft"
    | "importPackage" | "archiveTemplate"
    | "getTemplate" | "getTemplateVersion" | "listTemplateVersions" | "listTemplateAssets" | "listTemplateLibrary"
    | "createTask" | "getTask" | "getArchitectureSnapshot" | "listTasks" | "updateTask"
    | "getRun" | "updateRun" | "countRuns">;
  templateV3Migration?: AcpTemplateV3DraftMigrationRepository;
  configuration: Pick<ConfigurationStore,
    | "createTaskSetupDraft" | "getTaskSetupDraft" | "listTaskSetupDrafts" | "updateTaskSetupDraft"
    | "createMetaSession" | "getMetaSession" | "findActiveMetaSession" | "listMetaSessions" | "updateMetaSession"
    | "getMetaMessage" | "listMetaMessages" | "createMetaMessageAndTurn" | "getMetaTurn" | "listMetaTurns"
    | "getMetaPatchProposal" | "listMetaPatchProposals" | "updateMetaPatchProposal">;
  workspaces: Pick<WorkspaceAuthorizationStore, "createAuthorization" | "getAuthorization" | "listAuthorizations">;
  commands: Pick<CommandStore, "get" | "record">;
  taskRun: Pick<SessionIdTaskRunStore,
    "registerTask" | "ownsTask" | "listOwnedTaskIds"
    | "createRun" | "initializeSlot" | "resumeRun" | "markRunRunning" | "findSlot" | "listGenerations">;
  workspaceFiles: Pick<SessionIdWorkspaceStore, "getObservation">;
  retention: SessionIdTaskRetentionStore;
  canonicalizeWorkspaceDirectory: (directory: string) => Promise<Readonly<{
    canonicalDirectory: string;
    defaultDisplayName: string;
  }>>;
  resolveWorkspace: (authorization: WorkspaceAuthorizationRecord) => Promise<WorkspaceReferenceV3>;
  resolveMetaProfileOption: (metaProfileOptionId: string) => MetaProfileOptionSnapshot;
  assertMetaProfileReady: (profile: MetaProfileSnapshot, metaProfileOptionId: string) => Promise<void>;
  acpTaskLifecycle?: SessionIdAcpTaskLifecyclePort;
  acpTaskOwners?: SessionIdAcpTaskLifecycleOwnerCapabilities;
  createConductorLane: (scope: SessionIdOrchestrationTaskScope) => SessionIdConductorLane;
}>;

/**
 * Configuration + Task lifecycle owner for the Session-ID cutover target.
 *
 * It deliberately does not import or delegate to the superseded composition.
 * Every Run mutation is coordinated across narrow owner capabilities, while
 * Provider work is represented only by durable reliability intent consumed by
 * the shared Conductor lane.
 */
export function createSessionIdConfigurationTaskLifecycle(options: SessionIdConfigurationTaskLifecycleOptions) {
  function read(request: Readonly<{ taskId?: string }> = {}): SessionIdConfigurationTaskLifecycleReadModel {
    const templateLibrary = options.templates.listTemplateLibrary();
    const taskLibrary = Object.freeze(options.taskRun.listOwnedTaskIds().map((taskId) =>
      projectTask(required(options.templates.getTask(taskId), "session_id_task_marker_orphaned"))));
    const selected = request.taskId
      ? getTargetTask(request.taskId)
      : undefined;
    const currentTask = selected ? projectCurrentTask(selected) : undefined;
    return Object.freeze({
      configuration: Object.freeze({
        templateDrafts: Object.freeze([...options.templates.listDrafts()]),
        taskSetupDrafts: Object.freeze([...options.configuration.listTaskSetupDrafts()]),
        metaSessions: Object.freeze([...options.configuration.listMetaSessions()]),
        metaMessages: Object.freeze([...options.configuration.listMetaMessages()]),
        metaPatchProposals: Object.freeze([...options.configuration.listMetaPatchProposals()]),
      }),
      templateLibrary: Object.freeze(templateLibrary.map((entry) => Object.freeze({
        template: entry.template,
        ...(entry.activeVersion ? { activeVersion: entry.activeVersion } : {}),
      }))),
      taskSetupOptions: Object.freeze({
        templates: Object.freeze(templateLibrary.filter((entry) => !entry.template.archivedAt).map((entry) => Object.freeze({
          templateId: entry.template.templateId,
          title: entry.template.title,
          versions: Object.freeze(options.templates.listTemplateVersions(entry.template.templateId).map((version) => Object.freeze({
            templateVersionId: version.templateVersionId,
            version: version.version,
          }))),
        }))),
        workspaces: Object.freeze(options.workspaces.listAuthorizations().map((authorization) => Object.freeze({
          workspaceId: authorization.workspaceId,
          displayName: authorization.displayName,
        }))),
      }),
      taskLibrary,
      ...(currentTask ? { currentTask } : {}),
    });
  }

  async function execute(command: SessionIdConfigurationTaskLifecycleCommand): Promise<SessionIdConfigurationTaskLifecycleResult> {
    const fingerprint = commandFingerprint(command);
    const replay = options.commands.get(command.commandId);
    if (replay) {
      if (replay.commandType !== command.type || replay.payloadFingerprint !== fingerprint) {
        throw new Error("runtime_command_id_reused_with_different_payload");
      }
      return replay.result as SessionIdConfigurationTaskLifecycleResult;
    }
    switch (command.type) {
      case "workspace.authorize": return authorizeWorkspace(command, fingerprint);
      case "template.create_draft": return createDraft(command, fingerprint);
      case "template.save_draft": return saveDraft(command, fingerprint);
      case "template.migrate_v2_to_v3_draft": return migrateTemplateV2ToV3Draft(command, fingerprint);
      case "template.publish_draft": return publishDraft(command, fingerprint);
      case "template.archive": return archiveTemplateIdentity(command, fingerprint);
      case "template.import": return importTemplatePackage(command, fingerprint);
      case "template.export": return exportTemplateVersion(command, fingerprint);
      case "task_setup.create_draft": return createSetup(command, fingerprint);
      case "task_setup.save_draft": return saveSetup(command, fingerprint);
      case "task_setup.abandon_draft": return abandonSetup(command, fingerprint);
      case "meta.create_session": return openMeta(command, fingerprint);
      case "meta.send_message": return sendMeta(command, fingerprint);
      case "meta.abandon_session": return abandonMeta(command, fingerprint);
      case "meta.apply_patch": return applyMeta(command, fingerprint);
      case "meta.reject_patch": return rejectMeta(command, fingerprint);
      case "task.create": return createQueuedTask(command, fingerprint);
      case "task.start": return start(command, fingerprint, false);
      case "task.restart": return start(command, fingerprint, true);
      case "task.resume": return resume(command, fingerprint);
      case "task.achieve": return achieve(command, fingerprint);
      case "task.archive": return retainTask(command, fingerprint, true);
      case "task.restore": return retainTask(command, fingerprint, false);
      case "task.preview_permanent_delete": return previewPermanentDelete(command, fingerprint);
      case "task.permanently_delete": return permanentlyDelete(command, fingerprint);
    }
  }

  function retainTask(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task.archive" | "task.restore" }>,
    fingerprint: string,
    shouldArchive: boolean,
  ): SessionIdConfigurationTaskLifecycleResult {
    const retention = options.retention;
    const current = required(getTargetTask(command.taskId), "task_not_found");
    if (shouldArchive) retention.assertTaskQuiescent(current.taskId);
    const retained = shouldArchive
      ? archiveTask({ task: current, expectedRevision: command.expectedRevision, now: options.now() })
      : restoreTask({ task: current, expectedRevision: command.expectedRevision, now: options.now() });
    return commit(command, fingerprint, { task: projectTask(retained) }, () => {
      if (shouldArchive) retention.archiveTask(retained, current.revision);
      else retention.restoreTask(retained, current.revision);
    });
  }

  function previewPermanentDelete(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task.preview_permanent_delete" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const retention = options.retention;
    const preview = retention.previewPermanentDelete(command.taskId, command.expectedRevision);
    return commit(command, fingerprint, { permanentDeletePreview: preview }, () => undefined);
  }

  function permanentlyDelete(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task.permanently_delete" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const retention = options.retention;
    const replay = retention.getPermanentDeleteTombstone(command.commandId);
    if (replay) {
      if (replay.taskId !== command.taskId || replay.payloadFingerprint !== fingerprint) {
        throw new Error("runtime_command_id_reused_with_different_payload");
      }
      return commit(command, fingerprint, { permanentDelete: replay.result }, () => undefined);
    }
    const now = options.now();
    retention.preparePermanentDelete(Object.freeze({
      commandId: command.commandId,
      taskId: command.taskId,
      expectedRevision: command.expectedRevision,
      payloadFingerprint: fingerprint,
      preparedAt: now,
    }));
    const tombstone = retention.completePermanentDelete({
      commandId: command.commandId,
      taskId: command.taskId,
      payloadFingerprint: fingerprint,
      deletedAt: now,
    });
    return commit(command, fingerprint, { permanentDelete: tombstone.result }, () => undefined);
  }

  async function sendMeta(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "meta.send_message" }>,
    fingerprint: string,
  ): Promise<SessionIdConfigurationTaskLifecycleResult> {
    if (options.configuration.listMetaTurns().some((turn) =>
      turn.commandId === command.commandId || turn.idempotencyKey === command.idempotencyKey)) {
      throw new Error("meta_turn_command_retry_conflict");
    }
    const current = requiredAcpMetaSession(
      required(options.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found"),
    );
    if (current.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
    if (current.state !== "active") throw new Error("meta_session_not_active");
    const option = requiredAcpMetaOption(options.resolveMetaProfileOption(current.metaProfileOptionId));
    if (acpMetaProfileIdentity(option.profile) !== acpMetaProfileIdentity(current.metaProfile)) {
      throw new Error("meta_session_profile_snapshot_mismatch");
    }
    const context = sessionIdMetaTargetContext(current, command.expectedTargetRevision, options.templates, options.configuration);
    const systemInstructions = sessionIdMetaSystemInstructions(current.mode);
    const appended = appendMetaMessage({
      session: current,
      metaMessageId: options.createId("meta_message"),
      expectedSessionRevision: command.expectedSessionRevision,
      role: "user",
      content: command.content,
      now: options.now(),
    });
    const turn: AcpMetaTurnRecordV3 = Object.freeze({
      metaTurnId: options.createId("meta_turn"),
      metaSessionId: current.metaSessionId,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      userMetaMessageId: appended.message.metaMessageId,
      assistantMetaMessageId: options.createId("meta_message"),
      metaPatchProposalId: options.createId("meta_patch_proposal"),
      profile: current.metaProfile,
      mode: current.mode,
      targetRevision: command.expectedTargetRevision,
      systemInstructions,
      systemInstructionsDigest: hashDefinition(systemInstructions),
      outputSchema: META_AGENT_OUTPUT_SCHEMA,
      outputSchemaDigest: hashDefinition(META_AGENT_OUTPUT_SCHEMA),
      context,
      contextDigest: hashDefinition(context),
      status: "pending",
      attempts: 0,
      createdAt: appended.message.createdAt,
      updatedAt: appended.message.createdAt,
    });
    return commit(command, fingerprint, { metaSession: appended.session, metaMessage: appended.message }, () => {
      options.configuration.createMetaMessageAndTurn({
        session: requiredAcpMetaSession(appended.session),
        expectedSessionRevision: current.revision,
        userMessage: appended.message,
        turn,
      });
    });
  }

  async function authorizeWorkspace(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "workspace.authorize" }>,
    fingerprint: string,
  ): Promise<SessionIdConfigurationTaskLifecycleResult> {
    const resolved = await options.canonicalizeWorkspaceDirectory(command.directory);
    const authorization = createWorkspaceAuthorization({
      workspaceId: command.workspaceId,
      canonicalDirectory: resolved.canonicalDirectory,
      displayName: command.displayName?.trim() || resolved.defaultDisplayName,
      now: options.now(),
    });
    return commit(command, fingerprint, {}, () => options.workspaces.createAuthorization(authorization));
  }

  function activateRun(input: Readonly<{
    taskId: string;
    runId: string;
    conductorBindingId: string;
  }>): TaskRunRecord {
    const task = required(getTargetTask(input.taskId), "task_not_found");
    const run = required(options.templates.getRun(input.runId), "task_run_not_found");
    const architecture = required(options.templates.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    if (!isTaskArchitectureSnapshotV3(architecture)) throw new Error("template_v2_read_only");
    const owners = required(options.acpTaskOwners, "acp_task_lifecycle_owners_not_configured");
    const binding = required(owners.binding.getBinding(input.conductorBindingId), "binding_not_found");
    if (task.activeRunId !== run.runId || run.taskId !== task.taskId
      || binding.taskId !== task.taskId || binding.runId !== run.runId
      || binding.logicalSessionId !== run.conductorLogicalSessionId
      || binding.executionProfileId !== architecture.definition.conductor.executionProfileId) {
      throw new Error("session_id_run_binding_scope_mismatch");
    }
    if (binding.status !== "active" || !binding.recoverable
      || owners.binding.getCurrentBinding(binding.logicalSessionId)?.bindingId !== binding.bindingId) {
      throw new Error("session_id_conductor_binding_not_observed");
    }
    if (run.status === "running") return run;
    const running = markTaskRunRunning(run);
    options.taskRun.markRunRunning(running, run.revision);
    return running;
  }

  function createDraft(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "template.create_draft" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const base = command.baseTemplateVersionId
      ? required(options.templates.getTemplateVersion(command.baseTemplateVersionId), "template_draft_base_version_not_found")
      : undefined;
    if (base && command.templateId && base.templateId !== command.templateId) {
      throw new Error("template_draft_base_version_template_mismatch");
    }
    const definition = base?.definition ?? command.initialDefinition;
    if (!isTemplateDefinitionV3(definition)) throw new Error("template_v2_read_only");
    const draft = createTemplateDraft({
      templateDraftId: options.createId("template_draft"),
      ...(base
        ? { templateId: base.templateId, baseTemplateVersionId: base.templateVersionId }
        : command.templateId ? { templateId: command.templateId } : {}),
      metadata: command.metadata,
      definition,
      ownerId: command.ownerId,
      now: options.now(),
    });
    return commit(command, fingerprint, { templateDraft: draft }, () => options.templates.createDraft(draft));
  }

  function saveDraft(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "template.save_draft" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const current = required(options.templates.getDraft(command.templateDraftId), "template_draft_not_found");
    if (!isTemplateDefinitionV3(current.definition) || !isTemplateDefinitionV3(command.definition)) {
      throw new Error("template_v2_read_only");
    }
    const draft = saveTemplateDraft(current, command.expectedRevision, command.metadata, command.definition, options.now());
    return commit(command, fingerprint, { templateDraft: draft }, () => options.templates.updateDraft(draft, current.revision));
  }

  function migrateTemplateV2ToV3Draft(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "template.migrate_v2_to_v3_draft" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const migration = required(options.templateV3Migration, "template_v3_migration_owner_not_configured");
    const source = required(
      migration.readPublishedVersion(command.sourceTemplateVersionId),
      "acp_template_migration_source_not_found",
    );
    if (source.schemaVersion !== 2) throw new Error("acp_template_migration_source_not_v2");
    if (source.definitionHash !== command.expectedSourceDefinitionHash) {
      throw new Error("acp_template_migration_source_hash_stale");
    }
    const definition = validateTemplateDefinitionV3(command.definition);
    const now = options.now();
    const draft = createTemplateDraft({
      templateDraftId: options.createId("template_draft"),
      templateId: source.templateId,
      baseTemplateVersionId: source.templateVersionId,
      metadata: command.metadata,
      definition,
      ownerId: command.ownerId,
      now,
    });
    return commit(command, fingerprint, { templateDraft: draft }, () => {
      migration.createV3DraftFromPublishedV2({
        sourceTemplateVersionId: source.templateVersionId,
        expectedSourceDefinitionHash: source.definitionHash,
        draft: {
          templateDraftId: draft.templateDraftId,
          ownerId: draft.ownerId,
          metadata: draft.metadata,
          definition,
          createdAt: draft.createdAt,
        },
      });
    }, () => {
      const stored = required(options.templates.getDraft(draft.templateDraftId), "template_draft_not_found");
      if (stored.baseTemplateVersionId !== source.templateVersionId
        || stored.ownerId !== draft.ownerId
        || stored.revision !== 1
        || stored.status !== "editing"
        || hashDefinition(stored as unknown as JsonValue) !== hashDefinition(draft as unknown as JsonValue)) {
        throw new Error("acp_template_migration_draft_commit_mismatch");
      }
    });
  }

  function publishDraft(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "template.publish_draft" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const now = options.now();
    const draft = required(options.templates.getDraft(command.templateDraftId), "template_draft_not_found");
    if (!isTemplateDefinitionV3(draft.definition)) throw new Error("template_v2_read_only");
    const templateId = command.templateId ?? draft.templateId ?? options.createId("template");
    const template = options.templates.getTemplate(templateId) ?? createTemplateIdentity({
      templateId,
      slug: command.slug,
      title: command.title,
      ...(command.description ? { description: command.description } : {}),
      now,
    });
    const published = publishTemplateDraft({
      draft,
      template,
      expectedDraftRevision: command.expectedRevision,
      existingVersions: options.templates.listTemplateVersions(templateId),
      templateVersionId: options.createId("template_version"),
      now,
    });
    const activeMeta = options.configuration.findActiveMetaSession(draft.ownerId, {
      kind: "template_draft",
      templateDraftId: draft.templateDraftId,
    });
    const currentMeta = activeMeta ? requiredAcpMetaSession(activeMeta) : undefined;
    const consumedMeta = currentMeta
      ? requiredAcpMetaSession(consumeMetaSession(currentMeta, currentMeta.revision, now))
      : undefined;
    return commit(command, fingerprint, {
      templateDraft: published.draft,
      template: published.template,
      templateVersion: published.version,
      ...(consumedMeta ? { metaSession: consumedMeta } : {}),
    }, () => {
      options.templates.publishDraft(published.template, published.version, published.draft, command.expectedRevision);
      if (currentMeta && consumedMeta) options.configuration.updateMetaSession(consumedMeta, currentMeta.revision);
    });
  }

  function archiveTemplateIdentity(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "template.archive" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const now = options.now();
    const current = required(options.templates.getTemplate(command.templateId), "template_not_found");
    const archived = archiveTemplate(current, command.expectedRevision, now);
    return commit(command, fingerprint, { template: archived }, () => {
      options.templates.archiveTemplate(current.templateId, current.revision, now);
    });
  }

  function importTemplatePackage(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "template.import" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const now = options.now();
    const suppliedPackage = validateTemplatePackage(command.package);
    const definitionHash = hashDefinition(suppliedPackage.definition as unknown as JsonValue);
    if (suppliedPackage.template.definitionHash
      && suppliedPackage.template.definitionHash !== definitionHash) {
      throw new Error("template_import_definition_hash_mismatch");
    }
    const archive = validateTemplateArchivePayload({
      package: suppliedPackage,
      assets: decodeTemplateAssetTransports(command.assets),
    });
    const packageValue = archive.package;
    const existing = options.templates.getTemplate(packageValue.template.templateId);
    const existingVersion = existing
      ? options.templates.listTemplateVersions(existing.templateId)
        .find((candidate) => candidate.version === packageValue.template.version)
      : undefined;
    if ((command.mode === "create" && existing && !existingVersion)
      || (command.mode === "new_version" && !existing)) {
      throw new Error(command.mode === "create"
        ? "template_import_identity_exists"
        : "template_import_identity_missing");
    }
    const templateVersionId = existingVersion?.templateVersionId ?? options.createId("template_version");
    const template: TemplateRecord = existing
      ? Object.freeze({
        ...existing,
        title: packageValue.template.title,
        slug: packageValue.template.slug,
        ...(packageValue.template.description
          ? { description: packageValue.template.description }
          : { description: undefined }),
        activeVersionId: templateVersionId,
        revision: existingVersion ? existing.revision : existing.revision + 1,
        updatedAt: existingVersion ? existing.updatedAt : now,
      })
      : Object.freeze({
        templateId: packageValue.template.templateId,
        slug: packageValue.template.slug,
        title: packageValue.template.title,
        ...(packageValue.template.description ? { description: packageValue.template.description } : {}),
        activeVersionId: templateVersionId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    const version: TemplateVersionRecord = Object.freeze({
      templateVersionId,
      templateId: template.templateId,
      version: packageValue.template.version,
      definition: packageValue.definition,
      definitionHash,
      assetManifestHash: archive.assetManifestHash,
      createdAt: now,
      publishedAt: now,
    });
    const manifestByPath = new Map(archive.manifest.assets.map((asset) => [asset.path, asset] as const));
    const assets: readonly TemplateAssetRecord[] = Object.freeze(archive.assets.map((asset) => {
      const manifest = required(manifestByPath.get(asset.path), "template_asset_manifest_missing");
      return Object.freeze({
        templateVersionId,
        path: asset.path,
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        byteLength: asset.bytes.byteLength,
        contentDigest: manifest.contentDigest,
        bytes: Uint8Array.from(asset.bytes),
        createdAt: now,
      });
    }));
    return commit(command, fingerprint, {}, () => {
      options.templates.importPackage(template, version, packageValue, assets);
    });
  }

  function exportTemplateVersion(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "template.export" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const version = required(options.templates.getTemplateVersion(command.templateVersionId), "template_version_not_found");
    const template = required(options.templates.getTemplate(version.templateId), "template_not_found");
    const assets = options.templates.listTemplateAssets(version.templateVersionId).map((asset) => Object.freeze({
      path: asset.path,
      bytes: Uint8Array.from(asset.bytes),
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    }));
    const ordinaryPackage = templateVersionToPackage(template, version);
    const portablePackage: TemplatePackageSnapshot = assets.length === 0
      ? ordinaryPackage
      : Object.freeze({
        ...ordinaryPackage,
        template: Object.freeze({
          ...ordinaryPackage.template,
          assetManifestHash: version.assetManifestHash,
        }),
      });
    if (portablePackage.schemaVersion === 3) {
      const definition = validateTemplateDefinitionV3(portablePackage.definition);
      return commit(command, fingerprint, {
        templatePackage: Object.freeze({ ...portablePackage, definition }),
        templateAssets: encodeTemplateAssetTransports(assets),
      }, () => undefined);
    }
    const archive = validateTemplateArchivePayload({ package: portablePackage, assets });
    return commit(command, fingerprint, {
      templatePackage: archive.package,
      templateAssets: encodeTemplateAssetTransports(archive.assets),
    }, () => undefined);
  }

  function createSetup(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task_setup.create_draft" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const version = required(options.templates.getTemplateVersion(command.templateVersionId), "template_version_not_found");
    if (!isTemplateDefinitionV3(version.definition)) throw new Error("template_v2_read_only");
    const template = required(options.templates.getTemplate(version.templateId), "template_not_found");
    if (template.archivedAt) throw new Error("template_identity_archived");
    required(options.workspaces.getAuthorization(command.workspaceId), "workspace_not_authorized");
    const draft = createTaskSetupDraft({
      taskSetupDraftId: options.createId("task_setup_draft"),
      ownerId: command.ownerId,
      templateVersionId: version.templateVersionId,
      workspaceId: command.workspaceId,
      title: command.title,
      goal: command.goal,
      schema: version.definition.taskInputSchema,
      taskInputValues: command.taskInputValues,
      now: options.now(),
    });
    return commit(command, fingerprint, { taskSetupDraft: draft }, () => options.configuration.createTaskSetupDraft(draft));
  }

  function saveSetup(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task_setup.save_draft" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const current = required(options.configuration.getTaskSetupDraft(command.taskSetupDraftId), "task_setup_draft_not_found");
    if (current.ownerId !== command.ownerId) throw new Error("task_setup_owner_mismatch");
    const version = required(options.templates.getTemplateVersion(current.templateVersionId), "template_version_not_found");
    if (!isTemplateDefinitionV3(version.definition)) throw new Error("template_v2_read_only");
    required(options.workspaces.getAuthorization(command.workspaceId), "workspace_not_authorized");
    const draft = saveTaskSetupDraft(current, {
      expectedRevision: command.expectedRevision,
      workspaceId: command.workspaceId,
      title: command.title,
      goal: command.goal,
      schema: version.definition.taskInputSchema,
      taskInputValues: command.taskInputValues,
      now: options.now(),
    });
    return commit(command, fingerprint, { taskSetupDraft: draft }, () => options.configuration.updateTaskSetupDraft(draft, current.revision));
  }

  function abandonSetup(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task_setup.abandon_draft" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const current = required(options.configuration.getTaskSetupDraft(command.taskSetupDraftId), "task_setup_draft_not_found");
    if (current.ownerId !== command.ownerId) throw new Error("task_setup_owner_mismatch");
    const now = options.now();
    const draft = abandonTaskSetupDraft(current, command.expectedRevision, now);
    const activeMeta = options.configuration.findActiveMetaSession(command.ownerId, {
      kind: "task_setup_draft",
      taskSetupDraftId: current.taskSetupDraftId,
    });
    const currentMeta = activeMeta ? requiredAcpMetaSession(activeMeta) : undefined;
    const abandonedMeta = currentMeta
      ? requiredAcpMetaSession(abandonMetaSession(currentMeta, currentMeta.revision, now))
      : undefined;
    return commit(command, fingerprint, {
      taskSetupDraft: draft,
      ...(abandonedMeta ? { metaSession: abandonedMeta } : {}),
    }, () => {
      options.configuration.updateTaskSetupDraft(draft, current.revision);
      if (currentMeta && abandonedMeta) options.configuration.updateMetaSession(abandonedMeta, currentMeta.revision);
    });
  }

  async function openMeta(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "meta.create_session" }>,
    fingerprint: string,
  ): Promise<SessionIdConfigurationTaskLifecycleResult> {
    if (command.target.kind === "template_draft") {
      const draft = required(options.templates.getDraft(command.target.templateDraftId), "template_draft_not_found");
      if (draft.ownerId !== command.ownerId) throw new Error("meta_session_target_owner_mismatch");
      if (draft.status !== "editing") throw new Error("meta_session_target_not_editable");
    } else {
      const draft = required(options.configuration.getTaskSetupDraft(command.target.taskSetupDraftId), "task_setup_draft_not_found");
      if (draft.ownerId !== command.ownerId) throw new Error("meta_session_target_owner_mismatch");
      if (draft.state !== "draft") throw new Error("meta_session_target_not_editable");
    }
    const option = requiredAcpMetaOption(options.resolveMetaProfileOption(command.metaProfileOptionId));
    const existing = options.configuration.findActiveMetaSession(command.ownerId, command.target);
    if (existing) {
      const current = requiredAcpMetaSession(existing);
      if (current.metaProfileOptionId !== option.metaProfileOptionId
        || acpMetaProfileIdentity(current.metaProfile) !== acpMetaProfileIdentity(option.profile)) {
        throw new Error("meta_session_profile_snapshot_mismatch");
      }
      await options.assertMetaProfileReady(current.metaProfile, current.metaProfileOptionId);
      return commit(command, fingerprint, { metaSession: current }, () => undefined);
    }
    await options.assertMetaProfileReady(option.profile, option.metaProfileOptionId);
    const session = createMetaSessionV3({
      metaSessionId: options.createId("meta_session"),
      ownerId: command.ownerId,
      target: command.target,
      metaProfileOptionId: option.metaProfileOptionId,
      metaProfile: option.profile,
      now: options.now(),
    });
    return commit(command, fingerprint, { metaSession: session }, () => options.configuration.createMetaSession(session));
  }

  function abandonMeta(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "meta.abandon_session" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const current = requiredAcpMetaSession(
      required(options.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found"),
    );
    if (current.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
    const session = requiredAcpMetaSession(abandonMetaSession(current, command.expectedRevision, options.now()));
    return commit(command, fingerprint, { metaSession: session }, () => options.configuration.updateMetaSession(session, current.revision));
  }

  function applyMeta(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "meta.apply_patch" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const session = requiredAcpMetaSession(
      required(options.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found"),
    );
    const proposal = requiredAcpMetaProposal(
      required(options.configuration.getMetaPatchProposal(command.metaPatchProposalId), "meta_patch_proposal_not_found"),
    );
    if (session.ownerId !== command.ownerId || proposal.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
    if (session.mode === "template_design") {
      if (session.target.kind !== "template_draft") throw new Error("meta_session_mode_mismatch");
      const current = required(options.templates.getDraft(session.target.templateDraftId), "template_draft_not_found");
      const applied = applyMetaPatchProposalToTemplateDraft({
        draft: current,
        session,
        proposal,
        expectedTargetRevision: command.expectedTargetRevision,
        now: options.now(),
      });
      return commit(command, fingerprint, {
        templateDraft: applied.draft,
        metaSession: session,
        metaPatchProposal: applied.proposal,
      }, () => {
        options.templates.updateDraft(applied.draft, current.revision);
        options.configuration.updateMetaPatchProposal(requiredAcpMetaProposal(applied.proposal), proposal.revision);
      });
    }
    if (session.target.kind !== "task_setup_draft") throw new Error("meta_session_mode_mismatch");
    const current = required(options.configuration.getTaskSetupDraft(session.target.taskSetupDraftId), "task_setup_draft_not_found");
    const version = required(options.templates.getTemplateVersion(current.templateVersionId), "template_version_not_found");
    const applied = applyMetaPatchProposalToTaskSetup({
      draft: current,
      schema: version.definition.taskInputSchema,
      session,
      proposal,
      expectedTargetRevision: command.expectedTargetRevision,
      now: options.now(),
    });
    return commit(command, fingerprint, {
      taskSetupDraft: applied.draft,
      metaSession: session,
      metaPatchProposal: applied.proposal,
    }, () => {
      options.configuration.updateTaskSetupDraft(applied.draft, current.revision);
      options.configuration.updateMetaPatchProposal(requiredAcpMetaProposal(applied.proposal), proposal.revision);
    });
  }

  function rejectMeta(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "meta.reject_patch" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const session = requiredAcpMetaSession(
      required(options.configuration.getMetaSession(command.metaSessionId), "meta_session_not_found"),
    );
    const proposal = requiredAcpMetaProposal(
      required(options.configuration.getMetaPatchProposal(command.metaPatchProposalId), "meta_patch_proposal_not_found"),
    );
    if (session.ownerId !== command.ownerId || proposal.ownerId !== command.ownerId) throw new Error("meta_session_owner_mismatch");
    const rejected = rejectMetaPatchProposal({ proposal, session, now: options.now() });
    return commit(command, fingerprint, { metaSession: session, metaPatchProposal: rejected }, () => {
      options.configuration.updateMetaPatchProposal(requiredAcpMetaProposal(rejected), proposal.revision);
    });
  }

  async function createQueuedTask(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task.create" }>,
    fingerprint: string,
  ): Promise<SessionIdConfigurationTaskLifecycleResult> {
    const now = options.now();
    const setup = required(options.configuration.getTaskSetupDraft(command.taskSetupDraftId), "task_setup_draft_not_found");
    if (setup.ownerId !== command.ownerId) throw new Error("task_setup_owner_mismatch");
    if (setup.workspaceId !== command.workspaceId) throw new Error("task_setup_workspace_mismatch");
    if (setup.revision !== command.expectedTaskSetupRevision) throw new Error("task_setup_draft_revision_stale");
    const version = required(options.templates.getTemplateVersion(setup.templateVersionId), "template_version_not_found");
    if (!isTemplateDefinitionV3(version.definition)) throw new Error("template_v2_read_only");
    assertTaskSetupReadyForCreate(setup, version.definition.taskInputSchema);
    const authorization = required(options.workspaces.getAuthorization(setup.workspaceId), "workspace_not_authorized");
    const workspace = await options.resolveWorkspace(authorization);
    if (workspace.workspaceId !== authorization.workspaceId
      || !/^sha256:[a-f0-9]{64}$/u.test(workspace.grantDigest)) {
      throw new Error("workspace_resolution_mismatch");
    }
    const taskGoalContent = compileTaskGoal(setup, version.definition.taskInputSchema);
    return options.transaction(() => {
      const replay = options.commands.get(command.commandId);
      if (replay) {
        if (replay.commandType !== command.type || replay.payloadFingerprint !== fingerprint) {
          throw new Error("runtime_command_id_reused_with_different_payload");
        }
        return replay.result as SessionIdConfigurationTaskLifecycleResult;
      }
      const currentSetup = required(options.configuration.getTaskSetupDraft(command.taskSetupDraftId), "task_setup_draft_not_found");
      if (currentSetup.revision !== command.expectedTaskSetupRevision) throw new Error("task_setup_draft_revision_stale");
      const taskId = options.createId("task");
      const snapshot = createTaskArchitectureSnapshotV3({
        architectureSnapshotId: options.createId("architecture"),
        taskId,
        templateVersion: version,
        taskInputValues: currentSetup.taskInputValues,
        taskTitle: currentSetup.title,
        taskGoal: currentSetup.goal,
        taskGoalContent,
        taskGoalContentDigest: hashDefinition(taskGoalContent),
        taskGoalCompilerVersion: TASK_GOAL_COMPILER_VERSION,
        workspace,
        now,
      });
      const task = createTask({
        taskId,
        architectureSnapshotId: snapshot.architectureSnapshotId,
        title: currentSetup.title,
        goal: currentSetup.goal,
        now,
      });
      const consumedSetup = consumeTaskSetupDraft(currentSetup, task.taskId, command.expectedTaskSetupRevision, now);
      const activeMeta = options.configuration.findActiveMetaSession(currentSetup.ownerId, {
        kind: "task_setup_draft",
        taskSetupDraftId: currentSetup.taskSetupDraftId,
      });
      const currentMeta = activeMeta ? requiredAcpMetaSession(activeMeta) : undefined;
      const consumedMeta = currentMeta
        ? requiredAcpMetaSession(consumeMetaSession(currentMeta, currentMeta.revision, now))
        : undefined;
      return commitInCurrentTransaction(command, fingerprint, {
        task: projectTask(task),
        taskSetupDraft: consumedSetup,
        ...(consumedMeta ? { metaSession: consumedMeta } : {}),
      }, () => {
        options.templates.createTask({ task, snapshot });
        options.taskRun.registerTask(task.taskId, task.createdAt);
        options.configuration.updateTaskSetupDraft(consumedSetup, currentSetup.revision);
        if (currentMeta && consumedMeta) options.configuration.updateMetaSession(consumedMeta, currentMeta.revision);
      });
    });
  }

  async function start(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task.start" | "task.restart" }>,
    fingerprint: string,
    restart: boolean,
  ): Promise<SessionIdConfigurationTaskLifecycleResult> {
    const now = options.now();
    const task = required(getTargetTask(command.taskId), "task_not_found");
    const architecture = required(options.templates.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    if (!isTaskArchitectureSnapshotV3(architecture)) throw new Error("template_v2_read_only");
    const acpTaskLifecycle = required(options.acpTaskLifecycle, "acp_task_lifecycle_not_configured");
    const acpTaskOwners = required(options.acpTaskOwners, "acp_task_lifecycle_owners_not_configured");
    const runId = options.createId("run");
    const conductorSessionId = options.createId("logical_session");
    const runNumber = options.templates.countRuns(task.taskId) + 1;
    let started;
    if (restart) {
      const previousRun = required(task.activeRunId ? options.templates.getRun(task.activeRunId) : undefined, "task_active_run_not_found");
      started = restartTaskRun({
        task,
        previousRun,
        architecture,
        expectedRevision: command.expectedRevision,
        runId,
        conductorLogicalSessionId: conductorSessionId,
        runNumber,
        now,
      });
    } else {
      started = startTaskRun({
        task,
        architecture,
        expectedRevision: command.expectedRevision,
        runId,
        conductorLogicalSessionId: conductorSessionId,
        runNumber,
        now,
      });
    }
    const commandFence: SessionIdAcpTaskCommandFence = Object.freeze({
      operation: restart ? "restart" : "start",
      commandId: command.commandId,
      issuedAt: command.issuedAt,
      taskId: task.taskId,
      expectedTaskRevision: command.expectedRevision,
      runId: started.run.runId,
      conductorLogicalSessionId: started.run.conductorLogicalSessionId,
    });
    const prepared = validateSessionIdAcpTaskLifecyclePreparedResult(
      await acpTaskLifecycle.prepare({ architecture, commandFence, owners: acpTaskOwners }),
      { architecture, commandFence },
    );
    const slots = architecture.definition.agentCards.map<CardSessionSlotRecord>((card) => Object.freeze({
      cardSessionSlotId: options.createId("card_session_slot"),
      taskId: task.taskId,
      runId: started.run.runId,
      agentCardId: card.agentCardId,
      latestGeneration: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const taskGoalMessageId = options.createId("message");
    const lane = options.createConductorLane(Object.freeze({
      taskId: task.taskId,
      runId: started.run.runId,
      revision: started.task.revision,
      conductorSessionId: started.run.conductorLogicalSessionId,
      conductorSessionTurnId: sessionIdInitialConductorTurnId(started.run.runId, taskGoalMessageId),
      agentCards: Object.freeze(architecture.definition.agentCards.map((card) => Object.freeze({
        agentCardId: card.agentCardId,
        executionProfileId: card.executionProfileId,
      }))),
    }));
    return commit(command, fingerprint, {
      task: projectTask(started.task),
      run: started.run,
      acpTaskRuntime: prepared,
    }, () => {
      options.taskRun.createRun({
        task: started.task,
        expectedTaskRevision: task.revision,
        run: started.run,
      });
      for (const slot of slots) options.taskRun.initializeSlot(slot);
      acpTaskLifecycle.stage({ architecture, commandFence, prepared, owners: acpTaskOwners });
      verifyAcpTaskLifecycleStage(prepared, acpTaskOwners);
      lane.enqueueTaskGoal({ messageId: taskGoalMessageId, content: architecture.taskGoalContent });
    });
  }

  async function resume(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task.resume" }>,
    fingerprint: string,
  ): Promise<SessionIdConfigurationTaskLifecycleResult> {
    const now = options.now();
    const task = required(getTargetTask(command.taskId), "task_not_found");
    assertTaskNotTrashed(task);
    if (task.revision !== command.expectedRevision) throw new Error("expected_revision_stale");
    const run = required(options.templates.getRun(command.runId), "task_run_not_found");
    if (run.taskId !== task.taskId) throw new Error("task_run_mismatch");
    if (task.activeRunId !== run.runId) throw new Error("resume_requires_original_active_run");
    if (!(["blocked", "running"] as const).includes(task.status as "blocked" | "running")) {
      throw new Error("task_not_resumable");
    }
    const architecture = required(options.templates.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    if (!isTaskArchitectureSnapshotV3(architecture)) throw new Error("template_v2_read_only");
    const acpTaskLifecycle = required(options.acpTaskLifecycle, "acp_task_lifecycle_not_configured");
    const acpTaskOwners = required(options.acpTaskOwners, "acp_task_lifecycle_owners_not_configured");
    const resumedTask: TaskRecord = {
      ...task,
      status: "running",
      revision: task.revision + 1,
      updatedAt: now,
    };
    const resumedRun: TaskRunRecord = {
      ...run,
      status: "starting",
      revision: run.revision + 1,
    };
    const commandFence: SessionIdAcpTaskCommandFence = Object.freeze({
      operation: "resume",
      commandId: command.commandId,
      issuedAt: command.issuedAt,
      taskId: task.taskId,
      expectedTaskRevision: command.expectedRevision,
      runId: run.runId,
      expectedRunRevision: run.revision,
      conductorLogicalSessionId: run.conductorLogicalSessionId,
    });
    const prepared = validateSessionIdAcpTaskLifecyclePreparedResult(
      await acpTaskLifecycle.prepare({ architecture, commandFence, owners: acpTaskOwners }),
      { architecture, commandFence },
    );
    return commit(command, fingerprint, {
      task: projectTask(resumedTask),
      run: resumedRun,
      acpTaskRuntime: prepared,
    }, () => {
      options.taskRun.resumeRun({
        task: resumedTask,
        expectedTaskRevision: task.revision,
        run: resumedRun,
        expectedRunRevision: run.revision,
      });
      acpTaskLifecycle.stage({ architecture, commandFence, prepared, owners: acpTaskOwners });
      verifyAcpTaskLifecycleStage(prepared, acpTaskOwners);
    });
  }

  function achieve(
    command: Extract<SessionIdConfigurationTaskLifecycleCommand, { type: "task.achieve" }>,
    fingerprint: string,
  ): SessionIdConfigurationTaskLifecycleResult {
    const task = required(getTargetTask(command.taskId), "task_not_found");
    const observation = command.fileStateAnchor
      ? required(options.workspaceFiles.getObservation(command.fileStateAnchor.observationId), "workspace_observation_not_found")
      : undefined;
    if (observation && (observation.taskId !== task.taskId || observation.state !== "available" || !observation.contentDigest)) {
      throw new Error("file_state_anchor_observation_unavailable");
    }
    const fileStateAnchor = observation ? {
      workspaceRelativePath: observation.workspaceRelativePath,
      observedDigest: observation.contentDigest!,
      ...(command.fileStateAnchor?.label?.trim() ? { label: command.fileStateAnchor.label.trim() } : {}),
    } : undefined;
    const achieved = achieveTask({
      task,
      expectedRevision: command.expectedRevision,
      ...(fileStateAnchor ? { fileStateAnchor } : {}),
      ...(command.acceptanceNote ? { acceptanceNote: command.acceptanceNote } : {}),
      now: options.now(),
    });
    return commit(command, fingerprint, { task: projectTask(achieved) }, () => options.templates.updateTask(achieved, task.revision));
  }

  function commit(
    command: SessionIdConfigurationTaskLifecycleCommand,
    fingerprint: string,
    outcome: Omit<SessionIdConfigurationTaskLifecycleResult, "receipt">,
    mutate: () => void,
    verify?: () => void,
  ): SessionIdConfigurationTaskLifecycleResult {
    return options.transaction(() => commitInCurrentTransaction(command, fingerprint, outcome, mutate, verify));
  }

  function commitInCurrentTransaction(
    command: SessionIdConfigurationTaskLifecycleCommand,
    fingerprint: string,
    outcome: Omit<SessionIdConfigurationTaskLifecycleResult, "receipt">,
    mutate: () => void,
    verify?: () => void,
  ): SessionIdConfigurationTaskLifecycleResult {
    const acceptedAt = options.now();
    const receipt: RuntimeCommandReceipt = {
      commandId: command.commandId,
      acceptedAt,
      ...(outcome.task ? { taskRevision: outcome.task.revision } : {}),
    };
    const result: SessionIdConfigurationTaskLifecycleResult = Object.freeze({ receipt, ...outcome });
    mutate();
    verify?.();
    options.commands.record({
      commandId: command.commandId,
      commandType: command.type,
      payloadFingerprint: fingerprint,
      result: result as RuntimeCommandResult,
      acceptedAt,
    });
    return result;
  }

  function projectCurrentTask(task: TaskRecord): NonNullable<SessionIdConfigurationTaskLifecycleReadModel["currentTask"]> {
    const architecture = required(options.templates.getArchitectureSnapshot(task.taskId), "task_architecture_not_found");
    const activeRun = task.activeRunId ? options.templates.getRun(task.activeRunId) : undefined;
    const conductorBinding = activeRun && isTaskArchitectureSnapshotV3(architecture)
      ? options.acpTaskOwners?.binding.getCurrentBinding(activeRun.conductorLogicalSessionId)
      : undefined;
    const bindings = activeRun && isTaskArchitectureSnapshotV3(architecture)
      ? options.acpTaskOwners?.binding.listBindings(activeRun.conductorLogicalSessionId) ?? []
      : [];
    const availability = lifecycleAvailability(task, activeRun, bindings);
    return Object.freeze({
      task: projectTask(task),
      ...(activeRun ? {
        activeRun,
        conductorSessionId: activeRun.conductorLogicalSessionId,
      } : {}),
      ...(conductorBinding ? {
        conductorBinding: Object.freeze({
          bindingId: conductorBinding.bindingId,
          sessionId: conductorBinding.logicalSessionId,
          executionProfileId: conductorBinding.executionProfileId,
          provider: conductorBinding.providerFamily,
          status: conductorBinding.status,
          recoverable: conductorBinding.recoverable,
          revision: conductorBinding.revision,
        }),
      } : {}),
      lifecycle: availability,
      directory: Object.freeze(architecture.definition.agentCards.map((card) => {
        const slot = activeRun ? options.taskRun.findSlot(activeRun.runId, card.agentCardId) : undefined;
        return Object.freeze({
          agentCardId: card.agentCardId,
          title: card.title,
          ...(slot?.currentSessionId ? { currentSessionId: slot.currentSessionId } : {}),
          latestGeneration: slot?.latestGeneration ?? 0,
        });
      })),
    });
  }

  function getTargetTask(taskId: string): TaskRecord | undefined {
    if (!options.taskRun.ownsTask(taskId)) return undefined;
    return options.templates.getTask(taskId);
  }

  return Object.freeze({ read, execute, activateRun });
}

function lifecycleAvailability(
  task: TaskRecord,
  activeRun: TaskRunRecord | undefined,
  bindings: readonly AcpSafeSessionBindingRecordV3[],
): NonNullable<SessionIdConfigurationTaskLifecycleReadModel["currentTask"]>["lifecycle"] {
  let resumeBlockedReason: string | undefined;
  if (task.trashedAt) resumeBlockedReason = "task_trashed";
  else if (!activeRun) resumeBlockedReason = "task_active_run_not_found";
  else if (!(["blocked", "running"] as const).includes(task.status as "blocked" | "running")) resumeBlockedReason = "task_not_resumable";
  else if (bindings.length === 0) resumeBlockedReason = "resume_binding_not_found";
  else if (bindings.some((binding) => !binding.recoverable || binding.status !== "active")) {
    resumeBlockedReason = "resume_binding_not_recoverable";
  }

  let restartBlockedReason: string | undefined;
  if (task.trashedAt) restartBlockedReason = "task_trashed";
  else if (task.achievement) restartBlockedReason = "task_already_achieved";
  else if (!activeRun) restartBlockedReason = "task_active_run_not_found";
  else if (!(["stopped", "blocked"] as const).includes(task.status as "stopped" | "blocked")) restartBlockedReason = "task_not_restartable";
  else if (!["stopped", "failed", "cancellation_unknown"].includes(activeRun.status)) restartBlockedReason = "task_run_not_terminal";
  else if (bindings.length === 0 || bindings.some((binding) => !isTerminalBinding(binding))) restartBlockedReason = "task_restart_bindings_not_terminal";
  return Object.freeze({
    canResume: resumeBlockedReason === undefined,
    ...(resumeBlockedReason ? { resumeBlockedReason } : {}),
    canRestart: restartBlockedReason === undefined,
    ...(restartBlockedReason ? { restartBlockedReason } : {}),
  });
}

function commandFingerprint(command: SessionIdConfigurationTaskLifecycleCommand): string {
  return hashDefinition({ schemaVersion: 1, command: command as unknown as JsonValue });
}

function projectTask(task: TaskRecord): SessionIdTaskRecord {
  const achievement = task.achievement
    ? Object.freeze({
        achievedAt: task.achievement.achievedAt,
        ...(task.achievement.fileStateAnchor ? {
          fileStateAnchor: Object.freeze({ ...task.achievement.fileStateAnchor }),
        } : {}),
        ...(task.achievement.acceptanceNote ? { acceptanceNote: task.achievement.acceptanceNote } : {}),
      })
    : undefined;
  return Object.freeze({
    taskId: task.taskId,
    architectureSnapshotId: task.architectureSnapshotId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    ...(task.trashedAt ? { trashedAt: task.trashedAt } : {}),
    ...(achievement ? { achievement } : {}),
    ...(task.activeRunId ? { activeRunId: task.activeRunId } : {}),
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

export function sessionIdMetaTargetContext(
  session: MetaSessionRecord,
  expectedTargetRevision: number,
  templates: Pick<TemplateTaskStore, "getDraft" | "getTemplate" | "getTemplateVersion">,
  configuration: Pick<ConfigurationStore, "getTaskSetupDraft">,
): JsonValue {
  if (session.mode === "template_design") {
    if (session.target.kind !== "template_draft") throw new Error("meta_session_mode_mismatch");
    const draft = required(templates.getDraft(session.target.templateDraftId), "template_draft_not_found");
    if (draft.status !== "editing") throw new Error("meta_session_target_not_editable");
    if (draft.revision !== expectedTargetRevision) throw new Error("meta_patch_target_revision_stale");
    return {
      schemaVersion: 1,
      mode: "template_design",
      targetRevision: draft.revision,
      templateDraft: {
        metadata: draft.metadata,
        definition: metaTemplateDefinitionContext(draft.definition),
      },
    } as unknown as JsonValue;
  }
  if (session.target.kind !== "task_setup_draft") throw new Error("meta_session_mode_mismatch");
  const draft = required(configuration.getTaskSetupDraft(session.target.taskSetupDraftId), "task_setup_draft_not_found");
  if (draft.state !== "draft") throw new Error("meta_session_target_not_editable");
  if (draft.revision !== expectedTargetRevision) throw new Error("meta_patch_target_revision_stale");
  const version = required(templates.getTemplateVersion(draft.templateVersionId), "template_version_not_found");
  const template = required(templates.getTemplate(version.templateId), "template_not_found");
  return {
    schemaVersion: 1,
    mode: "task_setup",
    targetRevision: draft.revision,
    template: {
      title: template.title,
      slug: template.slug,
      ...(template.description === undefined ? {} : { description: template.description }),
      version: version.version,
      taskInputSchema: version.definition.taskInputSchema ?? { fields: [] },
    },
    taskSetupDraft: {
      title: draft.title,
      goal: draft.goal,
      taskInputValues: draft.taskInputValues,
    },
  } as unknown as JsonValue;
}

/** Configuration projection only: capability/tool references and legacy Host observations stay out. */
function metaTemplateDefinitionContext(definition: TemplateDefinition | TemplateDefinitionV3) {
  const card = (value: typeof definition.conductor | typeof definition.agentCards[number]) => ({
    agentCardId: value.agentCardId,
    kind: value.kind,
    title: value.title,
    systemPrompt: value.systemPrompt,
    executionProfileId: value.executionProfileId,
    ...(value.dispatchProfile ? { dispatchProfile: value.dispatchProfile } : {}),
  });
  return {
    schemaVersion: definition.schemaVersion,
    ...(definition.taskInputSchema ? { taskInputSchema: definition.taskInputSchema } : {}),
    conductor: card(definition.conductor),
    agentCards: definition.agentCards.map(card),
    executionProfiles: definition.schemaVersion === 3
      ? definition.executionProfiles.map((profile) => ({
          executionProfileId: profile.executionProfileId,
          profileRevisionId: profile.profileRevisionId,
          providerFamily: profile.providerFamily,
          acpAgentKind: profile.acpAgentKind,
          model: profile.model,
        }))
      : definition.executionProfiles.map((profile) => ({
          executionProfileId: profile.executionProfileId,
          provider: profile.provider,
          model: profile.model,
        })),
    routingPolicy: definition.routingPolicy,
    deliverables: definition.deliverables,
  };
}

export function sessionIdMetaSystemInstructions(mode: MetaSessionRecord["mode"]): string {
  const allowed = mode === "template_design"
    ? "template_metadata_set, template_conductor_prompt_edit, template_card_create, template_card_update, template_card_remove, template_card_reorder, template_card_prompt_edit, template_profile_revision_select, template_deliverable_upsert, template_deliverable_remove"
    : "task_setup_title_set, task_setup_goal_set, task_setup_input_set";
  return [
    "You are the configuration-only Meta Agent for Agent WorkSpace.",
    "You may reason only over the supplied configuration context and Meta conversation.",
    ...(mode === "template_design" ? [
      "Use only the injected template_draft MCP tools to read stable targets and construct localized proposal operations.",
      "These tools are proposal-only: they never mutate the Draft. Copy their returned operation objects into the final proposal.",
      "Every operation in the final proposal must come from an actual template_draft MCP tool call in this MetaTurn, in the same order. Runtime rejects directly authored, missing, reordered, or changed operations.",
      "Never use files, networks, credentials, Task transcripts, routing, lifecycle commands, or native child agents.",
    ] : [
      "Never use tools, files, networks, credentials, Task transcripts, routing, lifecycle commands, or native child agents.",
    ]),
    "Never publish a Template, create or start a Task, or claim that a patch was applied.",
    `The current mode is ${mode}. Allowed patch operation kinds: ${allowed}.`,
    ...(mode === "template_design" ? [
      "For template_card_create, use a proposal-local proposalRef; Runtime allocates the durable agentCardId.",
      "A new Card must reuse an executionProfileId already present in the supplied Template context and receives no new capabilityRefs.",
      "template_card_reorder.cardRefs must list every resulting Card exactly once, using existing agentCardId values or proposalRef values from this same proposal.",
      "For a small Prompt change, use template_conductor_prompt_edit or template_card_prompt_edit with the shortest oldText that occurs exactly once. Do not resend the complete Prompt.",
      "Change Provider, model, or effort only with template_profile_revision_select and a Host-issued profileRevisionId. Never invent a model string, configIntent, or Profile revision.",
      "Do not claim that Card creation is unsupported when these operations can satisfy the request.",
    ] : []),
    "validationIssues must list only problems that remain after applying every proposed operation and that block this proposal from being applied.",
    "Do not use validationIssues as a general audit of unchanged source fields, and do not repeat a source problem that the proposed operations resolve.",
    "When the complete proposed patch is applicable and introduces no unresolved blocker, return an empty validationIssues array.",
    "Return exactly one JSON object matching the supplied output schema; do not use Markdown fences or any text outside the JSON object.",
    "A proposal remains pending until the authenticated user explicitly applies it.",
  ].join("\n");
}

export function sessionIdInitialConductorTurnId(runId: string, messageId: string): string {
  return `session_turn_conductor_${hashDefinition({ runId, messageId }).replace(/[^a-zA-Z0-9]/g, "_")}`;
}

function verifyAcpTaskLifecycleStage(
  prepared: SessionIdAcpTaskLifecyclePreparedResult,
  owners: SessionIdAcpTaskLifecycleOwnerCapabilities,
): void {
  for (const expected of prepared.bindings) {
    const binding = required(owners.binding.getBinding(expected.bindingId), "acp_task_lifecycle_binding_not_staged");
    if (binding.schemaVersion !== 3
      || binding.taskId !== prepared.taskId
      || binding.runId !== prepared.runId
      || binding.logicalSessionId !== expected.logicalSessionId
      || binding.executionProfileId !== expected.executionProfileId
      || binding.profileRevisionId !== expected.profileRevisionId
      || binding.providerFamily !== expected.providerFamily
      || binding.bindingHandle !== expected.bindingHandle
      || binding.status !== "active"
      || binding.recoverable !== true) {
      throw new Error("acp_task_lifecycle_binding_stage_mismatch");
    }
    const current = owners.binding.getCurrentBinding(expected.logicalSessionId);
    if (!current || current.bindingId !== binding.bindingId) {
      throw new Error("acp_task_lifecycle_binding_not_current");
    }
    const runtime = required(
      owners.sessionRuntime.getRuntime(expected.sessionExecutionRuntimeId),
      "acp_task_lifecycle_runtime_not_staged",
    );
    if (runtime.taskId !== prepared.taskId
      || runtime.runId !== prepared.runId
      || runtime.logicalSessionId !== expected.logicalSessionId
      || runtime.state !== "idle") {
      throw new Error("acp_task_lifecycle_runtime_stage_mismatch");
    }
  }
}

function isTerminalBinding(binding: AcpSafeSessionBindingRecordV3): boolean {
  return binding.status === "unrecoverable" || binding.status === "released";
}

function requiredAcpMetaOption(
  option: MetaProfileOptionSnapshot,
): MetaProfileOptionDefinitionV3 {
  if (!("readiness" in option) || !isMetaProfileDefinitionV3(option.profile)) {
    throw new Error("meta_profile_v2_read_only");
  }
  return validateMetaProfileOptionDefinitionV3(option);
}

function requiredAcpMetaSession(session: MetaSessionRecord): MetaSessionRecordV3 {
  if (!isAcpMetaSession(session)) throw new Error("meta_profile_v2_read_only");
  return session;
}

function isAcpMetaSession(session: MetaSessionRecord): session is MetaSessionRecordV3 {
  return isMetaProfileDefinitionV3(session.metaProfile);
}

function requiredAcpMetaProposal(
  proposal: MetaPatchProposalRecord,
): MetaPatchProposalRecordV3 {
  if (!isAcpMetaProposal(proposal)) throw new Error("meta_profile_v2_read_only");
  return proposal;
}

function isAcpMetaProposal(
  proposal: MetaPatchProposalRecord,
): proposal is MetaPatchProposalRecordV3 {
  return isMetaProfileDefinitionV3(proposal.sourceMetaProfile);
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}
