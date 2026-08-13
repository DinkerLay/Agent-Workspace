import {
  canonicalJson,
  type JsonValue,
  type MetaMessageRecord,
  type MetaMessageId,
  type MetaPatchProposalRecord,
  type MetaPatchProposalRecordFor,
  type MetaPatchProposalRecordV3,
  type MetaPatchProposalId,
  type MetaProfileDefinitionV2,
  type MetaProfileDefinitionV3,
  type MetaProfileSnapshot,
  type MetaSessionRecord,
  type MetaSessionRecordFor,
  type MetaSessionRecordV3,
  type MetaSessionId,
  type MetaSessionMode,
  type MetaTurnId,
  type MetaTurnReadModel,
  type MetaTurnStatus,
  type RuntimeCommandId,
  type RuntimeCommandResult,
  type TaskArchitectureSnapshot,
  type TaskArchitectureSnapshotV2,
  type TaskRecord,
  type TaskRunRecord,
  type TaskSetupDraftRecord,
  EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
  type TemplateAssetRecord,
  type TemplateDraftRecord,
  type TemplatePackage,
  type TemplatePackageSnapshot,
  type TemplateRecord,
  type TemplateVersionRecord,
  type WorkspaceAuthorizationRecord,
  hashDefinition,
  isMetaProfileDefinitionV3,
  isTaskArchitectureSnapshotV3,
  validateMetaProfileSnapshot,
  validateTaskArchitectureSnapshotV3,
  validateTemplateDefinition,
  validateTemplateDefinitionSnapshot,
  validateTemplateDefinitionV3,
  validateTemplatePackageSnapshot,
} from "@agent-workspace/runtime-contracts";
import { decodeJson, encodeJson, SqliteRuntimeStore } from "./sqlite.js";

export type MetaTurnDispatchStatus = "pending" | "provider_accepted" | "ambiguous";

/** Configuration-owned Provider intent. It is never a Task Binding or ProviderFact. */
type MetaTurnRecordBase<Profile extends MetaProfileSnapshot> = {
  readonly metaTurnId: MetaTurnId;
  readonly metaSessionId: MetaSessionId;
  readonly commandId: RuntimeCommandId;
  readonly idempotencyKey: string;
  readonly userMetaMessageId: MetaMessageId;
  readonly assistantMetaMessageId: MetaMessageId;
  readonly metaPatchProposalId: MetaPatchProposalId;
  readonly profile: Profile;
  readonly mode: MetaSessionMode;
  readonly targetRevision: number;
  readonly systemInstructions: string;
  readonly systemInstructionsDigest: string;
  readonly outputSchema: JsonValue;
  readonly outputSchemaDigest: string;
  readonly context: JsonValue;
  readonly contextDigest: string;
  readonly status: MetaTurnStatus;
  readonly attempts: number;
  readonly leaseUntil?: string;
  /** Remembers whether an expired/released lease was sending or reconciling. */
  readonly leasedFromStatus?: MetaTurnDispatchStatus;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type MetaTurnRecordV2 = MetaTurnRecordBase<MetaProfileDefinitionV2>;
export type MetaTurnRecordV3 = MetaTurnRecordBase<MetaProfileDefinitionV3>;
export type AcpMetaTurnRecordV3 = MetaTurnRecordV3;
export type MetaTurnRecord = MetaTurnRecordV2 | MetaTurnRecordV3;

export type CreateMetaTurnStorageInput = Readonly<{
  session: MetaSessionRecordV3;
  expectedSessionRevision: number;
  userMessage: MetaMessageRecord;
  turn: AcpMetaTurnRecordV3;
}>;

export type SettleMetaTurnStorageInput = Readonly<{
  metaTurnId: MetaTurnId;
  expectedAttempts: number;
  status: "provider_accepted" | "rejected" | "ambiguous" | "failed";
  failureCode?: string;
  now: string;
}>;

export type CompleteMetaTurnStorageInput = Readonly<{
  metaTurnId: MetaTurnId;
  expectedAttempts: number;
  session: MetaSessionRecordV3;
  expectedSessionRevision: number;
  assistantMessage: MetaMessageRecord;
  proposal?: MetaPatchProposalRecordV3;
  completedAt: string;
}>;

export type CreateTaskStorageInput = {
  readonly task: TaskRecord;
  readonly snapshot: TaskArchitectureSnapshot;
};

export interface TemplateTaskStore {
  readonly createDraft: (draft: TemplateDraftRecord) => void;
  readonly getDraft: (draftId: string) => TemplateDraftRecord | undefined;
  readonly listDrafts: () => readonly TemplateDraftRecord[];
  readonly updateDraft: (draft: TemplateDraftRecord, expectedRevision: number) => void;
  readonly publishDraft: (template: TemplateRecord, version: TemplateVersionRecord, draft: TemplateDraftRecord, expectedRevision: number) => void;
  readonly importPackage: (
    template: TemplateRecord,
    version: TemplateVersionRecord,
    packageValue: TemplatePackageSnapshot,
    assets: readonly TemplateAssetRecord[],
  ) => "created" | "idempotent";
  readonly archiveTemplate: (templateId: string, expectedRevision: number, archivedAt: string) => TemplateRecord;
  readonly getTemplate: (templateId: string) => TemplateRecord | undefined;
  readonly getTemplateVersion: (templateVersionId: string) => TemplateVersionRecord | undefined;
  readonly listTemplateVersions: (templateId: string) => readonly TemplateVersionRecord[];
  readonly listTemplateAssets: (templateVersionId: string) => readonly TemplateAssetRecord[];
  readonly listTemplateLibrary: () => readonly { template: TemplateRecord; activeVersion?: TemplateVersionRecord }[];
  readonly createTask: (input: CreateTaskStorageInput) => void;
  readonly getTask: (taskId: string) => TaskRecord | undefined;
  readonly getArchitectureSnapshot: (taskId: string) => TaskArchitectureSnapshot | undefined;
  readonly listTasks: () => readonly TaskRecord[];
  readonly updateTask: (task: TaskRecord, expectedRevision: number) => void;
  readonly getRun: (runId: string) => TaskRunRecord | undefined;
  readonly updateRun: (run: TaskRunRecord) => void;
  readonly countRuns: (taskId: string) => number;
}

/** Durable command receipts make ambiguous client transport retries safe. */
export interface CommandStore {
  readonly get: (commandId: string) => StoredCommand | undefined;
  readonly record: (command: StoredCommand) => void;
}

export type StoredCommand = {
  readonly commandId: string;
  readonly commandType: string;
  readonly payloadFingerprint: string;
  readonly result: RuntimeCommandResult;
  readonly acceptedAt: string;
};

/** Host-private workspace directory authority. No Renderer receives this store. */
export interface WorkspaceAuthorizationStore {
  readonly createAuthorization: (authorization: WorkspaceAuthorizationRecord) => WorkspaceAuthorizationRecord;
  readonly getAuthorization: (workspaceId: string) => WorkspaceAuthorizationRecord | undefined;
  readonly listAuthorizations: () => readonly WorkspaceAuthorizationRecord[];
}

/** Template/Meta/Task Setup service is the only writer of configuration state. */
export interface ConfigurationStore {
  readonly createTaskSetupDraft: (draft: TaskSetupDraftRecord) => void;
  readonly getTaskSetupDraft: (taskSetupDraftId: string) => TaskSetupDraftRecord | undefined;
  readonly listTaskSetupDrafts: () => readonly TaskSetupDraftRecord[];
  readonly updateTaskSetupDraft: (draft: TaskSetupDraftRecord, expectedRevision: number) => void;
  readonly createMetaSession: (session: MetaSessionRecordV3) => void;
  readonly getMetaSession: (metaSessionId: string) => MetaSessionRecord | undefined;
  readonly findActiveMetaSession: (ownerId: string, target: MetaSessionRecord["target"]) => MetaSessionRecord | undefined;
  readonly listMetaSessions: () => readonly MetaSessionRecord[];
  readonly updateMetaSession: (session: MetaSessionRecordV3, expectedRevision: number) => void;
  readonly createMetaMessage: (message: MetaMessageRecord) => void;
  readonly getMetaMessage: (metaMessageId: string) => MetaMessageRecord | undefined;
  readonly listMetaMessages: (metaSessionId?: string) => readonly MetaMessageRecord[];
  readonly createMetaPatchProposal: (proposal: MetaPatchProposalRecordV3) => void;
  readonly getMetaPatchProposal: (metaPatchProposalId: string) => MetaPatchProposalRecord | undefined;
  readonly listMetaPatchProposals: (metaSessionId?: string) => readonly MetaPatchProposalRecord[];
  readonly updateMetaPatchProposal: (proposal: MetaPatchProposalRecordV3, expectedRevision: number) => void;
  readonly createMetaMessageAndTurn: (input: CreateMetaTurnStorageInput) => AcpMetaTurnRecordV3;
  readonly getMetaTurn: (metaTurnId: MetaTurnId) => MetaTurnRecord | undefined;
  readonly listMetaTurns: (metaSessionId?: MetaSessionId) => readonly MetaTurnRecord[];
  readonly claimMetaTurn: (now: string, leaseUntil: string) => AcpMetaTurnRecordV3 | undefined;
  readonly releaseMetaTurn: (metaTurnId: MetaTurnId, expectedAttempts: number, now: string) => AcpMetaTurnRecordV3;
  readonly settleMetaTurn: (input: SettleMetaTurnStorageInput) => AcpMetaTurnRecordV3;
  readonly completeMetaTurn: (input: CompleteMetaTurnStorageInput) => AcpMetaTurnRecordV3;
}

export interface RuntimeRepositories {
  readonly transaction: <T>(work: () => T) => T;
  readonly templateTask: TemplateTaskStore;
  readonly command: CommandStore;
  readonly workspace: WorkspaceAuthorizationStore;
  readonly configuration: ConfigurationStore;
}

/**
 * Store capabilities are deliberately split by writer. A composition root gives
 * each service only the matching member rather than this whole object.
 */
export function createRuntimeRepositories(store: SqliteRuntimeStore): RuntimeRepositories {
  const templateTask: TemplateTaskStore = {
    createDraft(draft) {
      validateTemplateDefinitionSnapshot(draft.definition);
      store.run(
        `INSERT INTO template_design_sessions(draft_id, template_id, base_template_version_id, metadata_json, definition_json, status, owner_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        draft.templateDraftId, draft.templateId ?? null, draft.baseTemplateVersionId ?? null,
        encodeJson(draft.metadata), encodeJson(draft.definition), draft.status, draft.ownerId, draft.revision, draft.createdAt, draft.updatedAt,
      );
    },
    getDraft(draftId) {
      const row = store.one<Row>("SELECT * FROM template_design_sessions WHERE draft_id = ?", draftId);
      return row ? toDraft(row) : undefined;
    },
    listDrafts() {
      return store.many<Row>("SELECT * FROM template_design_sessions WHERE status = ? ORDER BY updated_at DESC", "editing").map(toDraft);
    },
    updateDraft(draft, expectedRevision) {
      validateTemplateDefinitionSnapshot(draft.definition);
      const previous = store.one<Row>("SELECT revision FROM template_design_sessions WHERE draft_id = ?", draft.templateDraftId);
      if (!previous) throw new Error("template_draft_not_found");
      if (number(previous.revision) !== expectedRevision) throw new Error("stale_template_draft_revision");
      store.run(
        `UPDATE template_design_sessions SET metadata_json = ?, definition_json = ?, status = ?, revision = ?, updated_at = ? WHERE draft_id = ?`,
        encodeJson(draft.metadata), encodeJson(draft.definition), draft.status, draft.revision, draft.updatedAt, draft.templateDraftId,
      );
    },
    publishDraft(template, version, draft, expectedRevision) {
      const definition = validateTemplateDefinitionSnapshot(version.definition);
      if (definition.schemaVersion !== draft.definition.schemaVersion) {
        throw new Error("template_publish_schema_mismatch");
      }
      store.transaction(() => {
        const storedDraft = store.one<Row>("SELECT revision FROM template_design_sessions WHERE draft_id = ?", draft.templateDraftId);
        if (!storedDraft) throw new Error("template_draft_not_found");
        if (number(storedDraft.revision) !== expectedRevision) throw new Error("stale_template_draft_revision");
        const existing = store.one<Row>("SELECT definition_hash FROM template_versions WHERE template_id = ? AND version = ?", version.templateId, version.version);
        if (existing) throw new Error("template_version_already_exists");
        store.run(
          `INSERT INTO templates(template_id, slug, title, description, status, active_version_id, revision, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(template_id) DO UPDATE SET slug = excluded.slug, title = excluded.title, description = excluded.description,
             status = excluded.status, active_version_id = excluded.active_version_id, revision = excluded.revision,
             updated_at = excluded.updated_at, archived_at = excluded.archived_at`,
          template.templateId, template.slug, template.title, template.description ?? null,
          template.archivedAt ? "archived" : "active", version.templateVersionId, template.revision,
          template.createdAt, template.updatedAt, template.archivedAt ?? null,
        );
        store.run(
          `INSERT INTO template_versions(template_version_id, template_id, version, schema_version, definition_json, definition_hash, asset_manifest_hash, created_at, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          version.templateVersionId, version.templateId, version.version, version.definition.schemaVersion,
          encodeJson(version.definition), version.definitionHash, version.assetManifestHash ?? EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
          version.createdAt, version.publishedAt,
        );
        store.run(
          "UPDATE template_design_sessions SET status = ?, revision = ?, updated_at = ? WHERE draft_id = ?",
          "published", draft.revision, draft.updatedAt, draft.templateDraftId,
        );
      });
    },
    importPackage(template, version, packageValue, assets) {
      const validatedPackage = validateTemplatePackageSnapshot(packageValue);
      const definition = validatedPackage.definition;
      if (definition.schemaVersion !== version.definition.schemaVersion) {
        throw new Error("template_import_schema_mismatch");
      }
      if (validatedPackage.template.templateId !== template.templateId
        || version.templateId !== template.templateId
        || validatedPackage.template.version !== version.version
        || version.definitionHash !== hashDefinition(definition as unknown as JsonValue)
        || (validatedPackage.template.definitionHash !== undefined
          && version.definitionHash !== validatedPackage.template.definitionHash)) {
        throw new Error("template_import_identity_mismatch");
      }
      return store.transaction(() => {
        const assetManifestHash = version.assetManifestHash ?? EMPTY_TEMPLATE_ASSET_MANIFEST_HASH;
        const packageAssetManifestHash = validatedPackage.template.assetManifestHash ?? EMPTY_TEMPLATE_ASSET_MANIFEST_HASH;
        if (assetManifestHash !== packageAssetManifestHash) throw new Error("template_import_asset_manifest_mismatch");
        const sameVersion = store.one<Row>(
          "SELECT template_version_id, definition_hash, asset_manifest_hash FROM template_versions WHERE template_id = ? AND version = ?",
          version.templateId,
          version.version,
        );
        if (sameVersion) {
          if (text(sameVersion.definition_hash) !== version.definitionHash) throw new Error("template_import_version_conflict");
          if (text(sameVersion.asset_manifest_hash) !== assetManifestHash) throw new Error("template_import_asset_manifest_conflict");
          if (!sameTemplateAssets(store, text(sameVersion.template_version_id), assets)) {
            throw new Error("template_import_asset_manifest_conflict");
          }
          return "idempotent";
        }
        const sameHash = store.one<Row>(
          "SELECT template_version_id FROM template_versions WHERE template_id = ? AND definition_hash = ? AND asset_manifest_hash = ?",
          version.templateId,
          version.definitionHash,
          assetManifestHash,
        );
        if (sameHash) {
          if (!sameTemplateAssets(store, text(sameHash.template_version_id), assets)) {
            throw new Error("template_import_asset_manifest_conflict");
          }
          return "idempotent";
        }
        const existingTemplate = store.one<Row>("SELECT * FROM templates WHERE template_id = ?", template.templateId);
        if (existingTemplate) {
          store.run(
            "UPDATE templates SET active_version_id = ?, title = ?, description = ?, revision = revision + 1, updated_at = ? WHERE template_id = ?",
            version.templateVersionId, template.title, template.description ?? null, template.updatedAt, template.templateId,
          );
        } else {
          store.run(
            `INSERT INTO templates(template_id, slug, title, description, status, active_version_id, revision, created_at, updated_at, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            template.templateId, template.slug, template.title, template.description ?? null, "active",
            version.templateVersionId, template.revision, template.createdAt, template.updatedAt, null,
          );
        }
        store.run(
          `INSERT INTO template_versions(template_version_id, template_id, version, schema_version, definition_json, definition_hash, asset_manifest_hash, created_at, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          version.templateVersionId, version.templateId, version.version, version.definition.schemaVersion,
          encodeJson(definition), version.definitionHash, assetManifestHash, version.createdAt, version.publishedAt,
        );
        insertTemplateAssets(store, version.templateVersionId, assets);
        return "created";
      });
    },
    archiveTemplate(templateId, expectedRevision, archivedAt) {
      const row = store.one<Row>("SELECT * FROM templates WHERE template_id = ?", templateId);
      if (!row) throw new Error("template_not_found");
      const template = toTemplate(row);
      if (template.revision !== expectedRevision) throw new Error("stale_template_revision");
      const archived: TemplateRecord = { ...template, archivedAt, revision: template.revision + 1, updatedAt: archivedAt };
      store.run("UPDATE templates SET status = ?, revision = ?, updated_at = ?, archived_at = ? WHERE template_id = ?", "archived", archived.revision, archived.updatedAt, archivedAt, templateId);
      return archived;
    },
    getTemplate(templateId) {
      const row = store.one<Row>("SELECT * FROM templates WHERE template_id = ?", templateId);
      return row ? toTemplate(row) : undefined;
    },
    getTemplateVersion(templateVersionId) {
      const row = store.one<Row>("SELECT * FROM template_versions WHERE template_version_id = ?", templateVersionId);
      return row ? toTemplateVersion(row) : undefined;
    },
    listTemplateVersions(templateId) {
      return store.many<Row>("SELECT * FROM template_versions WHERE template_id = ? ORDER BY version", templateId).map(toTemplateVersion);
    },
    listTemplateAssets(templateVersionId) {
      return store.many<Row>("SELECT * FROM template_assets WHERE template_version_id = ? ORDER BY asset_path", templateVersionId).map(toTemplateAsset);
    },
    listTemplateLibrary() {
      const templates = store.many<Row>("SELECT * FROM templates ORDER BY archived_at IS NOT NULL, updated_at DESC");
      return templates.map((row) => {
        const template = toTemplate(row);
        const activeRow = template.activeVersionId
          ? store.one<Row>("SELECT * FROM template_versions WHERE template_version_id = ?", template.activeVersionId)
          : undefined;
        return activeRow ? { template, activeVersion: toTemplateVersion(activeRow) } : { template };
      });
    },
    createTask({ task, snapshot }) {
      const persistedSnapshot = isTaskArchitectureSnapshotV3(snapshot)
        ? validateTaskArchitectureSnapshotV3(snapshot)
        : validateTaskArchitectureSnapshotV2(snapshot);
      if (persistedSnapshot.taskId !== task.taskId
        || persistedSnapshot.architectureSnapshotId !== task.architectureSnapshotId) {
        throw new Error("task_architecture_identity_mismatch");
      }
      store.transaction(() => {
        store.run(
          `INSERT INTO task_architecture_snapshots(architecture_snapshot_id, task_id, template_id, template_version_id, template_definition_hash, definition_json, task_input_values_json, task_goal_content, task_goal_content_digest, task_goal_compiler_version, workspace_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          persistedSnapshot.architectureSnapshotId, persistedSnapshot.taskId, persistedSnapshot.templateId,
          persistedSnapshot.templateVersionId, persistedSnapshot.templateDefinitionHash,
          encodeJson(persistedSnapshot.definition), encodeJson(persistedSnapshot.taskInputValues),
          persistedSnapshot.taskGoalContent, persistedSnapshot.taskGoalContentDigest,
          persistedSnapshot.taskGoalCompilerVersion, encodeJson(persistedSnapshot.workspace), persistedSnapshot.createdAt,
        );
        store.run(
          `INSERT INTO tasks(task_id, architecture_snapshot_id, title, goal, status, trashed_at, achievement_json, active_run_id, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          task.taskId, task.architectureSnapshotId, task.title, task.goal, task.status, task.trashedAt ?? null,
          task.achievement ? encodeJson(task.achievement) : null, task.activeRunId ?? null,
          task.revision, task.createdAt, task.updatedAt,
        );
      });
    },
    getTask(taskId) {
      const row = store.one<Row>("SELECT * FROM tasks WHERE task_id = ?", taskId);
      return row ? toTask(row) : undefined;
    },
    getArchitectureSnapshot(taskId) {
      const row = store.one<Row>(
        `SELECT snapshot.*, task.title AS task_title, task.goal AS task_goal
         FROM task_architecture_snapshots snapshot
         JOIN tasks task ON task.task_id = snapshot.task_id
         WHERE snapshot.task_id = ?`,
        taskId,
      );
      return row ? toArchitectureSnapshot(row) : undefined;
    },
    listTasks() {
      return store.many<Row>("SELECT * FROM tasks ORDER BY updated_at DESC").map(toTask);
    },
    updateTask(task, expectedRevision) {
      const row = store.one<Row>("SELECT revision FROM tasks WHERE task_id = ?", task.taskId);
      if (!row) throw new Error("task_not_found");
      if (number(row.revision) !== expectedRevision) throw new Error("stale_task_revision");
      store.run(
        `UPDATE tasks SET title = ?, goal = ?, status = ?, trashed_at = ?, achievement_json = ?, active_run_id = ?, revision = ?, updated_at = ? WHERE task_id = ?`,
        task.title, task.goal, task.status, task.trashedAt ?? null, task.achievement ? encodeJson(task.achievement) : null,
        task.activeRunId ?? null, task.revision, task.updatedAt, task.taskId,
      );
    },
    getRun(runId) {
      const row = store.one<Row>("SELECT * FROM task_runs WHERE run_id = ?", runId);
      return row ? toRun(row) : undefined;
    },
    updateRun(run) {
      store.run("UPDATE task_runs SET status = ?, revision = ?, ended_at = ? WHERE run_id = ?", run.status, run.revision, run.endedAt ?? null, run.runId);
    },
    countRuns(taskId) {
      const row = store.one<Row>("SELECT COUNT(*) AS count FROM task_runs WHERE task_id = ?", taskId);
      return number(row?.count ?? 0);
    },
  };

  const workspace: WorkspaceAuthorizationStore = {
    createAuthorization(authorization) {
      const currentRow = store.one<Row>("SELECT * FROM workspace_authorizations WHERE workspace_id = ?", authorization.workspaceId);
      const current = currentRow ? toWorkspaceAuthorization(currentRow) : undefined;
      if (current) {
        if (
          current.canonicalDirectory === authorization.canonicalDirectory
          && current.displayName === authorization.displayName
        ) {
          return current;
        }
        throw new Error("workspace_authorization_id_conflict");
      }
      const sameDirectory = store.one<Row>(
        "SELECT * FROM workspace_authorizations WHERE canonical_directory = ?",
        authorization.canonicalDirectory,
      );
      if (sameDirectory) throw new Error("workspace_directory_already_authorized");
      store.run(
        `INSERT INTO workspace_authorizations(workspace_id, canonical_directory, display_name, authorized_at)
         VALUES (?, ?, ?, ?)`,
        authorization.workspaceId,
        authorization.canonicalDirectory,
        authorization.displayName,
        authorization.authorizedAt,
      );
      return authorization;
    },
    getAuthorization(workspaceId) {
      const row = store.one<Row>("SELECT * FROM workspace_authorizations WHERE workspace_id = ?", workspaceId);
      return row ? toWorkspaceAuthorization(row) : undefined;
    },
    listAuthorizations() {
      return store.many<Row>("SELECT * FROM workspace_authorizations ORDER BY authorized_at DESC").map(toWorkspaceAuthorization);
    },
  };

  const configuration: ConfigurationStore = {
    createTaskSetupDraft(draft) {
      store.run(
        `INSERT INTO task_setup_drafts(task_setup_draft_id, owner_id, template_version_id, workspace_id, title, goal, task_input_values_json, state, created_task_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        draft.taskSetupDraftId,
        draft.ownerId,
        draft.templateVersionId,
        draft.workspaceId,
        draft.title,
        draft.goal,
        encodeJson(draft.taskInputValues),
        draft.state,
        draft.createdTaskId ?? null,
        draft.revision,
        draft.createdAt,
        draft.updatedAt,
      );
    },
    getTaskSetupDraft(taskSetupDraftId) {
      const row = store.one<Row>("SELECT * FROM task_setup_drafts WHERE task_setup_draft_id = ?", taskSetupDraftId);
      return row ? toTaskSetupDraft(row) : undefined;
    },
    listTaskSetupDrafts() {
      return store.many<Row>("SELECT * FROM task_setup_drafts ORDER BY updated_at DESC, task_setup_draft_id").map(toTaskSetupDraft);
    },
    updateTaskSetupDraft(draft, expectedRevision) {
      const row = store.one<Row>("SELECT revision FROM task_setup_drafts WHERE task_setup_draft_id = ?", draft.taskSetupDraftId);
      if (!row) throw new Error("task_setup_draft_not_found");
      if (number(row.revision) !== expectedRevision) throw new Error("stale_task_setup_draft_revision");
      store.run(
        `UPDATE task_setup_drafts
         SET workspace_id = ?, title = ?, goal = ?, task_input_values_json = ?, state = ?, created_task_id = ?, revision = ?, updated_at = ?
         WHERE task_setup_draft_id = ?`,
        draft.workspaceId,
        draft.title,
        draft.goal,
        encodeJson(draft.taskInputValues),
        draft.state,
        draft.createdTaskId ?? null,
        draft.revision,
        draft.updatedAt,
        draft.taskSetupDraftId,
      );
    },
    createMetaSession(session) {
      requiredAcpMetaProfile(session.metaProfile);
      store.run(
        `INSERT INTO meta_sessions(meta_session_id, owner_id, mode, target_kind, target_id, meta_profile_option_id, meta_profile_json, state, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        session.metaSessionId,
        session.ownerId,
        session.mode,
        session.target.kind,
        metaTargetId(session.target),
        session.metaProfileOptionId,
        encodeJson(session.metaProfile),
        session.state,
        session.revision,
        session.createdAt,
        session.updatedAt,
      );
    },
    getMetaSession(metaSessionId) {
      const row = store.one<Row>("SELECT * FROM meta_sessions WHERE meta_session_id = ?", metaSessionId);
      return row ? toMetaSession(row) : undefined;
    },
    findActiveMetaSession(ownerId, target) {
      const row = store.one<Row>(
        "SELECT * FROM meta_sessions WHERE owner_id = ? AND target_kind = ? AND target_id = ? AND state = 'active'",
        ownerId,
        target.kind,
        metaTargetId(target),
      );
      return row ? toMetaSession(row) : undefined;
    },
    listMetaSessions() {
      return store.many<Row>("SELECT * FROM meta_sessions ORDER BY updated_at DESC, meta_session_id").map(toMetaSession);
    },
    updateMetaSession(session, expectedRevision) {
      requiredAcpMetaProfile(session.metaProfile);
      const row = store.one<Row>("SELECT * FROM meta_sessions WHERE meta_session_id = ?", session.metaSessionId);
      if (!row) throw new Error("meta_session_not_found");
      if (number(row.revision) !== expectedRevision) throw new Error("stale_meta_session_revision");
      const current = toMetaSession(row);
      requiredAcpMetaProfile(current.metaProfile);
      assertSameDurableValue(
        metaSessionImmutable(current),
        metaSessionImmutable(session),
        "meta_session_identity_conflict",
      );
      store.run(
        "UPDATE meta_sessions SET state = ?, revision = ?, updated_at = ? WHERE meta_session_id = ?",
        session.state,
        session.revision,
        session.updatedAt,
        session.metaSessionId,
      );
    },
    createMetaMessage(message) {
      const session = this.getMetaSession(message.metaSessionId);
      if (!session) throw new Error("meta_session_not_found");
      requiredAcpMetaProfile(session.metaProfile);
      const existing = this.getMetaMessage(message.metaMessageId);
      if (existing) {
        assertSameDurableValue(existing, message, "meta_message_id_conflict");
        return;
      }
      store.run(
        `INSERT INTO meta_messages(meta_message_id, meta_session_id, owner_id, role, content, content_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        message.metaMessageId,
        message.metaSessionId,
        message.ownerId,
        message.role,
        message.content,
        message.contentDigest,
        message.createdAt,
      );
    },
    getMetaMessage(metaMessageId) {
      const row = store.one<Row>("SELECT * FROM meta_messages WHERE meta_message_id = ?", metaMessageId);
      return row ? toMetaMessage(row) : undefined;
    },
    listMetaMessages(metaSessionId) {
      const rows = metaSessionId
        ? store.many<Row>("SELECT * FROM meta_messages WHERE meta_session_id = ? ORDER BY created_at, meta_message_id", metaSessionId)
        : store.many<Row>("SELECT * FROM meta_messages ORDER BY created_at, meta_message_id");
      return rows.map(toMetaMessage);
    },
    createMetaPatchProposal(proposal) {
      requiredAcpMetaProfile(proposal.sourceMetaProfile);
      const existing = this.getMetaPatchProposal(proposal.metaPatchProposalId);
      if (existing) {
        assertSameDurableValue(existing, proposal, "meta_patch_proposal_id_conflict");
        return;
      }
      store.run(
        `INSERT INTO meta_patch_proposals(meta_patch_proposal_id, meta_session_id, owner_id, mode, target_kind, target_id, source_meta_profile_option_id, source_meta_profile_json, source_meta_session_revision, target_revision, operations_json, summary, rationale, validation_issues_json, state, applied_target_revision, revision, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        proposal.metaPatchProposalId,
        proposal.metaSessionId,
        proposal.ownerId,
        proposal.mode,
        proposal.target.kind,
        metaTargetId(proposal.target),
        proposal.sourceMetaProfileOptionId,
        encodeJson(proposal.sourceMetaProfile),
        proposal.sourceMetaSessionRevision,
        proposal.targetRevision,
        encodeJson(proposal.operations),
        proposal.summary,
        proposal.rationale,
        encodeJson(proposal.validationIssues),
        proposal.state,
        proposal.appliedTargetRevision ?? null,
        proposal.revision,
        proposal.createdAt,
        proposal.updatedAt,
        proposal.resolvedAt ?? null,
      );
    },
    getMetaPatchProposal(metaPatchProposalId) {
      const row = store.one<Row>("SELECT * FROM meta_patch_proposals WHERE meta_patch_proposal_id = ?", metaPatchProposalId);
      return row ? toMetaPatchProposal(row) : undefined;
    },
    listMetaPatchProposals(metaSessionId) {
      const rows = metaSessionId
        ? store.many<Row>("SELECT * FROM meta_patch_proposals WHERE meta_session_id = ? ORDER BY created_at, meta_patch_proposal_id", metaSessionId)
        : store.many<Row>("SELECT * FROM meta_patch_proposals ORDER BY created_at, meta_patch_proposal_id");
      return rows.map(toMetaPatchProposal);
    },
    updateMetaPatchProposal(proposal, expectedRevision) {
      requiredAcpMetaProfile(proposal.sourceMetaProfile);
      const row = store.one<Row>("SELECT * FROM meta_patch_proposals WHERE meta_patch_proposal_id = ?", proposal.metaPatchProposalId);
      if (!row) throw new Error("meta_patch_proposal_not_found");
      if (number(row.revision) !== expectedRevision) throw new Error("stale_meta_patch_proposal_revision");
      const current = toMetaPatchProposal(row);
      requiredAcpMetaProfile(current.sourceMetaProfile);
      assertSameDurableValue(
        metaProposalImmutable(current),
        metaProposalImmutable(proposal),
        "meta_patch_proposal_identity_conflict",
      );
      store.run(
        `UPDATE meta_patch_proposals
         SET state = ?, applied_target_revision = ?, revision = ?, updated_at = ?, resolved_at = ?
         WHERE meta_patch_proposal_id = ?`,
        proposal.state,
        proposal.appliedTargetRevision ?? null,
        proposal.revision,
        proposal.updatedAt,
        proposal.resolvedAt ?? null,
        proposal.metaPatchProposalId,
      );
    },
    createMetaMessageAndTurn(input) {
      return store.transaction(() => {
        assertNewMetaTurnInput(input);
        const collisions = store.many<Row>(
          `SELECT * FROM meta_turns
           WHERE meta_turn_id = ? OR command_id = ? OR idempotency_key = ? OR user_meta_message_id = ?`,
          input.turn.metaTurnId,
          input.turn.commandId,
          input.turn.idempotencyKey,
          input.turn.userMetaMessageId,
        ).map(toMetaTurn);
        if (collisions.length > 0) {
          if (collisions.length !== 1) throw new Error("meta_turn_identity_conflict");
          const existing = requiredAcpMetaTurn(collisions[0]!);
          assertSameMetaTurnIntent(existing, input.turn);
          const existingMessage = this.getMetaMessage(existing.userMetaMessageId);
          if (!existingMessage) throw new Error("meta_turn_user_message_missing");
          assertSameDurableValue(existingMessage, input.userMessage, "meta_turn_user_message_conflict");
          return existing;
        }
        const currentSession = this.getMetaSession(input.session.metaSessionId);
        if (!currentSession) throw new Error("meta_session_not_found");
        requiredAcpMetaProfile(currentSession.metaProfile);
        if (currentSession.revision !== input.expectedSessionRevision) throw new Error("stale_meta_session_revision");
        const active = store.one<Row>(
          `SELECT meta_turn_id FROM meta_turns
           WHERE meta_session_id = ? AND status IN ('pending', 'leased', 'provider_accepted', 'ambiguous')`,
          input.turn.metaSessionId,
        );
        if (active) throw new Error("meta_turn_active");
        this.createMetaMessage(input.userMessage);
        insertMetaTurn(store, input.turn);
        this.updateMetaSession(input.session, input.expectedSessionRevision);
        return input.turn;
      });
    },
    getMetaTurn(metaTurnId) {
      const row = store.one<Row>("SELECT * FROM meta_turns WHERE meta_turn_id = ?", metaTurnId);
      return row ? toMetaTurn(row) : undefined;
    },
    listMetaTurns(metaSessionId) {
      const rows = metaSessionId
        ? store.many<Row>("SELECT * FROM meta_turns WHERE meta_session_id = ? ORDER BY created_at, meta_turn_id", metaSessionId)
        : store.many<Row>("SELECT * FROM meta_turns ORDER BY created_at, meta_turn_id");
      return rows.map(toMetaTurn);
    },
    claimMetaTurn(now, leaseUntil) {
      assertLeaseWindow(now, leaseUntil);
      return store.transaction(() => {
        const rows = store.many<Row>(
          `SELECT * FROM meta_turns
           WHERE status IN ('pending', 'provider_accepted', 'ambiguous')
              OR (status = 'leased' AND lease_until < ?)
           ORDER BY
             CASE
               WHEN status = 'pending' OR (status = 'leased' AND leased_from_status = 'pending') THEN 0
               ELSE 1
             END,
             CASE
               WHEN status = 'pending' OR (status = 'leased' AND leased_from_status = 'pending') THEN created_at
               ELSE updated_at
             END,
             meta_turn_id
           `,
          now,
        );
        const current = rows.map(toMetaTurn).find(isAcpMetaTurnV3);
        if (!current) return undefined;
        const leasedFromStatus = current.status === "leased" ? current.leasedFromStatus : current.status;
        if (!isMetaTurnDispatchStatus(leasedFromStatus)) throw new Error("meta_turn_lease_origin_invalid");
        const claimed: AcpMetaTurnRecordV3 = {
          ...current,
          status: "leased",
          attempts: current.attempts + 1,
          leaseUntil,
          leasedFromStatus,
          updatedAt: now,
        };
        store.run(
          `UPDATE meta_turns
           SET status = 'leased', attempts = ?, lease_until = ?, leased_from_status = ?, updated_at = ?
           WHERE meta_turn_id = ?`,
          claimed.attempts,
          leaseUntil,
          leasedFromStatus,
          now,
          claimed.metaTurnId,
        );
        return claimed;
      });
    },
    releaseMetaTurn(metaTurnId, expectedAttempts, now) {
      return store.transaction(() => {
        const current = requiredAcpMetaTurnRecord(store, metaTurnId);
        if (
          isMetaTurnDispatchStatus(current.status)
          && current.attempts === expectedAttempts
          && current.leaseUntil === undefined
          && current.leasedFromStatus === undefined
        ) return current;
        if (current.status !== "leased") throw new Error("meta_turn_not_leased");
        if (current.attempts !== expectedAttempts) throw new Error("stale_meta_turn_attempt");
        if (!isMetaTurnDispatchStatus(current.leasedFromStatus)) throw new Error("meta_turn_lease_origin_invalid");
        const released: AcpMetaTurnRecordV3 = {
          ...current,
          status: current.leasedFromStatus,
          leaseUntil: undefined,
          leasedFromStatus: undefined,
          updatedAt: now,
        };
        updateMetaTurnDispatchState(store, released);
        return released;
      });
    },
    settleMetaTurn(input) {
      assertMetaTurnSettlement(input);
      return store.transaction(() => {
        const current = requiredAcpMetaTurnRecord(store, input.metaTurnId);
        if (
          current.status === input.status
          && current.attempts === input.expectedAttempts
          && current.failureCode === input.failureCode
          && current.leaseUntil === undefined
        ) return current;
        if (current.status !== "leased") throw new Error("meta_turn_not_leased");
        if (current.attempts !== input.expectedAttempts) throw new Error("stale_meta_turn_attempt");
        const settled: AcpMetaTurnRecordV3 = {
          ...current,
          status: input.status,
          leaseUntil: undefined,
          leasedFromStatus: undefined,
          ...(input.failureCode === undefined ? { failureCode: undefined } : { failureCode: input.failureCode }),
          updatedAt: input.now,
        };
        updateMetaTurnDispatchState(store, settled);
        return settled;
      });
    },
    completeMetaTurn(input) {
      return store.transaction(() => {
        const current = requiredAcpMetaTurnRecord(store, input.metaTurnId);
        if (current.status === "returned") {
          assertCompletedMetaTurnReplay(this, current, input);
          return current;
        }
        if (current.status !== "leased") throw new Error("meta_turn_not_leased");
        if (current.attempts !== input.expectedAttempts) throw new Error("stale_meta_turn_attempt");
        assertMetaTurnCompletion(current, input);
        const storedSession = this.getMetaSession(input.session.metaSessionId);
        if (!storedSession) throw new Error("meta_session_not_found");
        requiredAcpMetaProfile(storedSession.metaProfile);
        if (storedSession.revision !== input.expectedSessionRevision) throw new Error("stale_meta_session_revision");
        this.createMetaMessage(input.assistantMessage);
        if (input.proposal) this.createMetaPatchProposal(input.proposal);
        this.updateMetaSession(input.session, input.expectedSessionRevision);
        const returned: AcpMetaTurnRecordV3 = {
          ...current,
          status: "returned",
          leaseUntil: undefined,
          leasedFromStatus: undefined,
          failureCode: undefined,
          updatedAt: input.completedAt,
        };
        updateMetaTurnDispatchState(store, returned);
        return returned;
      });
    },
  };

  const command: CommandStore = {
    get(commandId) {
      const row = store.one<Row>("SELECT * FROM runtime_commands WHERE command_id = ?", commandId);
      return row ? toStoredCommand(row) : undefined;
    },
    record(value) {
      store.run(
        `INSERT INTO runtime_commands(command_id, command_type, payload_fingerprint, result_json, accepted_at)
         VALUES (?, ?, ?, ?, ?)`,
        value.commandId,
        value.commandType,
        value.payloadFingerprint,
        encodeJson(value.result),
        value.acceptedAt,
      );
    },
  };

  return {
    transaction: (work) => store.transaction(work),
    templateTask,
    command,
    workspace,
    configuration,
  };
}

type Row = Record<string, unknown>;

function insertMetaTurn(store: SqliteRuntimeStore, turn: MetaTurnRecord): void {
  store.run(
    `INSERT INTO meta_turns(
       meta_turn_id, meta_session_id, command_id, idempotency_key,
       user_meta_message_id, assistant_meta_message_id, meta_patch_proposal_id,
       profile_json, mode, target_revision,
       system_instructions, system_instructions_digest, output_schema_json, output_schema_digest,
       context_json, context_digest, status, attempts, lease_until, leased_from_status,
       failure_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    turn.metaTurnId,
    turn.metaSessionId,
    turn.commandId,
    turn.idempotencyKey,
    turn.userMetaMessageId,
    turn.assistantMetaMessageId,
    turn.metaPatchProposalId,
    encodeJson(turn.profile),
    turn.mode,
    turn.targetRevision,
    turn.systemInstructions,
    turn.systemInstructionsDigest,
    encodeJson(turn.outputSchema),
    turn.outputSchemaDigest,
    encodeJson(turn.context),
    turn.contextDigest,
    turn.status,
    turn.attempts,
    turn.leaseUntil ?? null,
    turn.leasedFromStatus ?? null,
    turn.failureCode ?? null,
    turn.createdAt,
    turn.updatedAt,
  );
}

function toMetaTurn(row: Row): MetaTurnRecord {
  const status = requiredMetaTurnStatus(row.status);
  const leasedFromStatus = optionalText(row.leased_from_status);
  if (leasedFromStatus !== undefined && !isMetaTurnDispatchStatus(leasedFromStatus)) {
    throw new Error("runtime_store_meta_turn_lease_origin_invalid");
  }
  const profile = validateMetaProfileSnapshot(decodeJson<unknown>(row.profile_json));
  return isMetaProfileDefinitionV3(profile)
    ? toMetaTurnWithProfile(row, status, leasedFromStatus, profile)
    : toMetaTurnWithProfile(row, status, leasedFromStatus, profile);
}

function toMetaTurnWithProfile<Profile extends MetaProfileSnapshot>(
  row: Row,
  status: MetaTurnStatus,
  leasedFromStatus: MetaTurnDispatchStatus | undefined,
  profile: Profile,
): MetaTurnRecordBase<Profile> {
  return compact({
    metaTurnId: text(row.meta_turn_id),
    metaSessionId: text(row.meta_session_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    userMetaMessageId: text(row.user_meta_message_id),
    assistantMetaMessageId: text(row.assistant_meta_message_id),
    metaPatchProposalId: text(row.meta_patch_proposal_id),
    profile,
    mode: requiredMetaSessionMode(row.mode),
    targetRevision: number(row.target_revision),
    systemInstructions: text(row.system_instructions),
    systemInstructionsDigest: text(row.system_instructions_digest),
    outputSchema: decodeJson<JsonValue>(row.output_schema_json),
    outputSchemaDigest: text(row.output_schema_digest),
    context: decodeJson<JsonValue>(row.context_json),
    contextDigest: text(row.context_digest),
    status,
    attempts: number(row.attempts),
    leaseUntil: optionalText(row.lease_until),
    leasedFromStatus,
    failureCode: optionalText(row.failure_code),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toMetaTurnReadModel(turn: MetaTurnRecord): MetaTurnReadModel {
  return compact({
    metaTurnId: turn.metaTurnId,
    metaSessionId: turn.metaSessionId,
    userMetaMessageId: turn.userMetaMessageId,
    assistantMetaMessageId: turn.assistantMetaMessageId,
    metaPatchProposalId: turn.metaPatchProposalId,
    mode: turn.mode,
    targetRevision: turn.targetRevision,
    status: turn.status,
    attempts: turn.attempts,
    failureCode: turn.failureCode,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  });
}

function requiredAcpMetaProfile(profile: MetaProfileSnapshot): MetaProfileDefinitionV3 {
  const validated = validateMetaProfileSnapshot(profile);
  if (!isMetaProfileDefinitionV3(validated)) throw new Error("meta_profile_v2_read_only");
  return validated;
}

function isAcpMetaTurnV3(turn: MetaTurnRecord): turn is AcpMetaTurnRecordV3 {
  return isMetaProfileDefinitionV3(turn.profile);
}

function requiredAcpMetaTurn(turn: MetaTurnRecord): AcpMetaTurnRecordV3 {
  if (!isAcpMetaTurnV3(turn)) throw new Error("meta_profile_v2_read_only");
  return turn;
}

function metaSessionImmutable(session: MetaSessionRecord) {
  return {
    metaSessionId: session.metaSessionId,
    ownerId: session.ownerId,
    mode: session.mode,
    target: session.target,
    metaProfileOptionId: session.metaProfileOptionId,
    metaProfile: session.metaProfile,
    createdAt: session.createdAt,
  };
}

function metaProposalImmutable(proposal: MetaPatchProposalRecord) {
  return {
    metaPatchProposalId: proposal.metaPatchProposalId,
    metaSessionId: proposal.metaSessionId,
    ownerId: proposal.ownerId,
    mode: proposal.mode,
    target: proposal.target,
    sourceMetaProfileOptionId: proposal.sourceMetaProfileOptionId,
    sourceMetaProfile: proposal.sourceMetaProfile,
    sourceMetaSessionRevision: proposal.sourceMetaSessionRevision,
    targetRevision: proposal.targetRevision,
    operations: proposal.operations,
    summary: proposal.summary,
    rationale: proposal.rationale,
    validationIssues: proposal.validationIssues,
    createdAt: proposal.createdAt,
  };
}

function assertNewMetaTurnInput(input: CreateMetaTurnStorageInput): void {
  const { session, expectedSessionRevision, userMessage, turn } = input;
  requiredAcpMetaProfile(session.metaProfile);
  requiredAcpMetaProfile(turn.profile);
  if (!turn.metaTurnId.startsWith("meta_turn_")) throw new Error("meta_turn_id_invalid");
  if (!turn.commandId.startsWith("command_")) throw new Error("meta_turn_command_id_invalid");
  if (!turn.idempotencyKey) throw new Error("meta_turn_idempotency_key_required");
  if (!turn.userMetaMessageId.startsWith("meta_message_")) throw new Error("meta_turn_user_message_id_invalid");
  if (!turn.assistantMetaMessageId.startsWith("meta_message_")) throw new Error("meta_turn_assistant_message_id_invalid");
  if (!turn.metaPatchProposalId.startsWith("meta_patch_proposal_")) throw new Error("meta_turn_proposal_id_invalid");
  if (new Set([turn.userMetaMessageId, turn.assistantMetaMessageId]).size !== 2) throw new Error("meta_turn_message_ids_conflict");
  if (turn.metaSessionId !== session.metaSessionId || userMessage.metaSessionId !== session.metaSessionId) {
    throw new Error("meta_turn_session_mismatch");
  }
  if (turn.mode !== session.mode) throw new Error("meta_turn_mode_mismatch");
  assertSameDurableValue(turn.profile, session.metaProfile, "meta_turn_profile_mismatch");
  if (!Number.isSafeInteger(turn.targetRevision) || turn.targetRevision < 1) throw new Error("meta_turn_target_revision_invalid");
  if (!turn.systemInstructions.trim()) throw new Error("meta_turn_system_instructions_required");
  if (turn.systemInstructionsDigest !== hashDefinition(turn.systemInstructions)) {
    throw new Error("meta_turn_system_instructions_digest_mismatch");
  }
  if (turn.outputSchemaDigest !== hashDefinition(turn.outputSchema)) throw new Error("meta_turn_output_schema_digest_mismatch");
  if (turn.contextDigest !== hashDefinition(turn.context)) throw new Error("meta_turn_context_digest_mismatch");
  if (turn.status !== "pending" || turn.attempts !== 0 || turn.leaseUntil || turn.leasedFromStatus || turn.failureCode) {
    throw new Error("meta_turn_initial_state_invalid");
  }
  if (session.state !== "active") throw new Error("meta_session_not_active");
  if (session.revision !== expectedSessionRevision + 1) throw new Error("meta_session_revision_transition_invalid");
  if (userMessage.metaMessageId !== turn.userMetaMessageId || userMessage.ownerId !== session.ownerId || userMessage.role !== "user") {
    throw new Error("meta_turn_user_message_mismatch");
  }
  if (userMessage.contentDigest !== hashDefinition(userMessage.content)) throw new Error("meta_turn_user_message_digest_mismatch");
  if (turn.createdAt !== turn.updatedAt || userMessage.createdAt !== turn.createdAt || session.updatedAt !== turn.createdAt) {
    throw new Error("meta_turn_timestamp_mismatch");
  }
}

function assertSameMetaTurnIntent(existing: MetaTurnRecord, incoming: MetaTurnRecord): void {
  const immutable = (turn: MetaTurnRecord) => ({
    metaTurnId: turn.metaTurnId,
    metaSessionId: turn.metaSessionId,
    commandId: turn.commandId,
    idempotencyKey: turn.idempotencyKey,
    userMetaMessageId: turn.userMetaMessageId,
    assistantMetaMessageId: turn.assistantMetaMessageId,
    metaPatchProposalId: turn.metaPatchProposalId,
    profile: turn.profile,
    mode: turn.mode,
    targetRevision: turn.targetRevision,
    systemInstructions: turn.systemInstructions,
    systemInstructionsDigest: turn.systemInstructionsDigest,
    outputSchema: turn.outputSchema,
    outputSchemaDigest: turn.outputSchemaDigest,
    context: turn.context,
    contextDigest: turn.contextDigest,
    createdAt: turn.createdAt,
  });
  assertSameDurableValue(immutable(existing), immutable(incoming), "meta_turn_identity_conflict");
}

function requiredMetaTurn(store: SqliteRuntimeStore, metaTurnId: string): MetaTurnRecord {
  const row = store.one<Row>("SELECT * FROM meta_turns WHERE meta_turn_id = ?", metaTurnId);
  if (!row) throw new Error("meta_turn_not_found");
  return toMetaTurn(row);
}

function requiredAcpMetaTurnRecord(
  store: SqliteRuntimeStore,
  metaTurnId: string,
): AcpMetaTurnRecordV3 {
  return requiredAcpMetaTurn(requiredMetaTurn(store, metaTurnId));
}

function updateMetaTurnDispatchState(store: SqliteRuntimeStore, turn: MetaTurnRecord): void {
  store.run(
    `UPDATE meta_turns
     SET status = ?, attempts = ?, lease_until = ?, leased_from_status = ?, failure_code = ?, updated_at = ?
     WHERE meta_turn_id = ?`,
    turn.status,
    turn.attempts,
    turn.leaseUntil ?? null,
    turn.leasedFromStatus ?? null,
    turn.failureCode ?? null,
    turn.updatedAt,
    turn.metaTurnId,
  );
}

function assertLeaseWindow(now: string, leaseUntil: string): void {
  const nowEpoch = Date.parse(now);
  const leaseEpoch = Date.parse(leaseUntil);
  if (!Number.isFinite(nowEpoch) || !Number.isFinite(leaseEpoch) || leaseEpoch <= nowEpoch) {
    throw new Error("meta_turn_lease_window_invalid");
  }
}

function isMetaTurnDispatchStatus(value: unknown): value is MetaTurnDispatchStatus {
  return value === "pending" || value === "provider_accepted" || value === "ambiguous";
}

function requiredMetaTurnStatus(value: unknown): MetaTurnStatus {
  const status = text(value) as MetaTurnStatus;
  if (!["pending", "leased", "provider_accepted", "returned", "rejected", "ambiguous", "failed"].includes(status)) {
    throw new Error("runtime_store_meta_turn_status_invalid");
  }
  return status;
}

function requiredMetaSessionMode(value: unknown): MetaSessionMode {
  const mode = text(value);
  if (mode !== "template_design" && mode !== "task_setup") throw new Error("runtime_store_meta_turn_mode_invalid");
  return mode;
}

function assertMetaTurnSettlement(input: SettleMetaTurnStorageInput): void {
  if (!Number.isSafeInteger(input.expectedAttempts) || input.expectedAttempts < 1) throw new Error("meta_turn_attempt_invalid");
  if (input.status === "provider_accepted") {
    if (input.failureCode !== undefined) throw new Error("meta_turn_failure_code_not_allowed");
    return;
  }
  if (!input.failureCode || !/^[a-z][a-z0-9_.:-]{0,159}$/.test(input.failureCode)) {
    throw new Error("meta_turn_failure_code_invalid");
  }
}

function assertMetaTurnCompletion(current: MetaTurnRecord, input: CompleteMetaTurnStorageInput): void {
  const { session, expectedSessionRevision, assistantMessage, proposal, completedAt } = input;
  if (session.metaSessionId !== current.metaSessionId || assistantMessage.metaSessionId !== current.metaSessionId) {
    throw new Error("meta_turn_session_mismatch");
  }
  if (session.mode !== current.mode || session.state !== "active") throw new Error("meta_turn_mode_mismatch");
  if (session.revision !== expectedSessionRevision + 1) throw new Error("meta_session_revision_transition_invalid");
  if (
    assistantMessage.metaMessageId !== current.assistantMetaMessageId
    || assistantMessage.ownerId !== session.ownerId
    || assistantMessage.role !== "assistant"
  ) throw new Error("meta_turn_assistant_message_mismatch");
  if (assistantMessage.contentDigest !== hashDefinition(assistantMessage.content)) throw new Error("meta_turn_assistant_message_digest_mismatch");
  if (assistantMessage.createdAt !== completedAt || session.updatedAt !== completedAt) throw new Error("meta_turn_timestamp_mismatch");
  if (!proposal) return;
  if (
    proposal.metaPatchProposalId !== current.metaPatchProposalId
    || proposal.metaSessionId !== current.metaSessionId
    || proposal.ownerId !== session.ownerId
    || proposal.mode !== current.mode
    || proposal.targetRevision !== current.targetRevision
    || proposal.sourceMetaSessionRevision !== expectedSessionRevision
    || proposal.sourceMetaProfileOptionId !== session.metaProfileOptionId
  ) throw new Error("meta_turn_proposal_mismatch");
  assertSameDurableValue(proposal.target, session.target, "meta_turn_proposal_target_mismatch");
  assertSameDurableValue(proposal.sourceMetaProfile, current.profile, "meta_turn_proposal_profile_mismatch");
}

function assertCompletedMetaTurnReplay(
  configuration: ConfigurationStore,
  current: MetaTurnRecord,
  input: CompleteMetaTurnStorageInput,
): void {
  if (current.attempts !== input.expectedAttempts || current.updatedAt !== input.completedAt) {
    throw new Error("meta_turn_completion_conflict");
  }
  const message = configuration.getMetaMessage(current.assistantMetaMessageId);
  if (!message) throw new Error("meta_turn_assistant_message_missing");
  assertSameDurableValue(message, input.assistantMessage, "meta_turn_assistant_message_conflict");
  const proposal = configuration.getMetaPatchProposal(current.metaPatchProposalId);
  if (input.proposal) {
    if (!proposal) throw new Error("meta_turn_proposal_missing");
    assertSameDurableValue(proposal, input.proposal, "meta_turn_proposal_conflict");
  } else if (proposal) {
    throw new Error("meta_turn_proposal_conflict");
  }
}

function toTemplate(row: Row): TemplateRecord {
  return compact({
    templateId: text(row.template_id), slug: text(row.slug), title: text(row.title),
    description: optionalText(row.description), activeVersionId: optionalText(row.active_version_id), archivedAt: optionalText(row.archived_at),
    revision: number(row.revision), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
  });
}

function toTemplateVersion(row: Row): TemplateVersionRecord {
  const schemaVersion = number(row.schema_version);
  const definition = schemaVersion === 2
    ? validateTemplateDefinition(decodeJson<unknown>(row.definition_json))
    : schemaVersion === 3
      ? validateTemplateDefinitionV3(decodeJson<unknown>(row.definition_json))
      : undefined;
  if (!definition) throw new Error("runtime_store_template_version_schema_unsupported");
  return {
    templateVersionId: text(row.template_version_id),
    templateId: text(row.template_id),
    version: number(row.version),
    definition,
    definitionHash: text(row.definition_hash),
    assetManifestHash: optionalText(row.asset_manifest_hash) ?? EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
    createdAt: text(row.created_at),
    publishedAt: text(row.published_at),
  };
}

function toTemplateAsset(row: Row): TemplateAssetRecord {
  const bytes = binary(row.bytes);
  const byteLength = number(row.byte_length);
  if (bytes.byteLength !== byteLength) throw new Error("runtime_store_template_asset_length_mismatch");
  return compact({
    templateVersionId: text(row.template_version_id),
    path: text(row.asset_path),
    contentType: optionalText(row.content_type),
    byteLength,
    contentDigest: text(row.content_digest),
    bytes: Uint8Array.from(bytes),
    createdAt: text(row.created_at),
  });
}

function toDraft(row: Row): TemplateDraftRecord {
  return compact({
    templateDraftId: text(row.draft_id), templateId: optionalText(row.template_id), baseTemplateVersionId: optionalText(row.base_template_version_id),
    metadata: decodeJson<TemplateDraftRecord["metadata"]>(row.metadata_json),
    definition: validateTemplateDefinitionSnapshot(decodeJson<unknown>(row.definition_json)),
    status: text(row.status) as TemplateDraftRecord["status"], ownerId: text(row.owner_id),
    revision: number(row.revision), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
  });
}

function toTaskSetupDraft(row: Row): TaskSetupDraftRecord {
  return compact({
    taskSetupDraftId: text(row.task_setup_draft_id),
    ownerId: text(row.owner_id),
    templateVersionId: text(row.template_version_id),
    workspaceId: text(row.workspace_id),
    title: text(row.title),
    goal: text(row.goal),
    taskInputValues: decodeJson<TaskSetupDraftRecord["taskInputValues"]>(row.task_input_values_json),
    state: text(row.state) as TaskSetupDraftRecord["state"],
    createdTaskId: optionalText(row.created_task_id),
    revision: number(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toMetaSession(row: Row): MetaSessionRecord {
  const profile = validateMetaProfileSnapshot(decodeJson<unknown>(row.meta_profile_json));
  return isMetaProfileDefinitionV3(profile)
    ? toMetaSessionWithProfile(row, profile)
    : toMetaSessionWithProfile(row, profile);
}

function toMetaSessionWithProfile<Profile extends MetaProfileSnapshot>(
  row: Row,
  metaProfile: Profile,
): MetaSessionRecordFor<Profile> {
  const targetKind = text(row.target_kind);
  const mode = text(row.mode);
  const base = {
    metaSessionId: text(row.meta_session_id),
    ownerId: text(row.owner_id),
    metaProfileOptionId: text(row.meta_profile_option_id),
    metaProfile,
    state: text(row.state) as MetaSessionRecord["state"],
    revision: number(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
  if (targetKind === "template_draft" && mode === "template_design") {
    return { ...base, mode, target: { kind: targetKind, templateDraftId: text(row.target_id) } };
  }
  if (targetKind === "task_setup_draft" && mode === "task_setup") {
    return { ...base, mode, target: { kind: targetKind, taskSetupDraftId: text(row.target_id) } };
  }
  throw new Error("runtime_store_meta_session_target_invalid");
}

function toMetaMessage(row: Row): MetaMessageRecord {
  return {
    metaMessageId: text(row.meta_message_id),
    metaSessionId: text(row.meta_session_id),
    ownerId: text(row.owner_id),
    role: text(row.role) as MetaMessageRecord["role"],
    content: text(row.content),
    contentDigest: text(row.content_digest),
    createdAt: text(row.created_at),
  };
}

function toMetaPatchProposal(row: Row): MetaPatchProposalRecord {
  const profile = validateMetaProfileSnapshot(decodeJson<unknown>(row.source_meta_profile_json));
  return isMetaProfileDefinitionV3(profile)
    ? toMetaPatchProposalWithProfile(row, profile)
    : toMetaPatchProposalWithProfile(row, profile);
}

function toMetaPatchProposalWithProfile<Profile extends MetaProfileSnapshot>(
  row: Row,
  sourceMetaProfile: Profile,
): MetaPatchProposalRecordFor<Profile> {
  const targetKind = text(row.target_kind);
  const targetId = text(row.target_id);
  const target = targetKind === "template_draft"
    ? { kind: targetKind, templateDraftId: targetId } as const
    : targetKind === "task_setup_draft"
      ? { kind: targetKind, taskSetupDraftId: targetId } as const
      : undefined;
  if (!target) throw new Error("runtime_store_meta_patch_target_invalid");
  return compact({
    metaPatchProposalId: text(row.meta_patch_proposal_id),
    metaSessionId: text(row.meta_session_id),
    ownerId: text(row.owner_id),
    mode: text(row.mode) as MetaPatchProposalRecord["mode"],
    target,
    sourceMetaProfileOptionId: text(row.source_meta_profile_option_id),
    sourceMetaProfile,
    sourceMetaSessionRevision: number(row.source_meta_session_revision),
    targetRevision: number(row.target_revision),
    operations: decodeJson<MetaPatchProposalRecord["operations"]>(row.operations_json),
    summary: text(row.summary),
    rationale: text(row.rationale),
    validationIssues: decodeJson<MetaPatchProposalRecord["validationIssues"]>(row.validation_issues_json),
    state: text(row.state) as MetaPatchProposalRecord["state"],
    appliedTargetRevision: row.applied_target_revision === null || row.applied_target_revision === undefined
      ? undefined
      : number(row.applied_target_revision),
    revision: number(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    resolvedAt: optionalText(row.resolved_at),
  });
}

function metaTargetId(target: MetaSessionRecord["target"]): string {
  return target.kind === "template_draft" ? target.templateDraftId : target.taskSetupDraftId;
}

function toTask(row: Row): TaskRecord {
  return compact({
    taskId: text(row.task_id), architectureSnapshotId: text(row.architecture_snapshot_id), title: text(row.title), goal: text(row.goal),
    status: text(row.status) as TaskRecord["status"], trashedAt: optionalText(row.trashed_at),
    achievement: row.achievement_json ? decodeJson<TaskRecord["achievement"]>(row.achievement_json) : undefined,
    activeRunId: optionalText(row.active_run_id), revision: number(row.revision),
    createdAt: text(row.created_at), updatedAt: text(row.updated_at),
  });
}

function toArchitectureSnapshot(row: Row): TaskArchitectureSnapshot {
  const definition = validateTemplateDefinitionSnapshot(decodeJson<unknown>(row.definition_json));
  if (definition.schemaVersion === 3) {
    return validateTaskArchitectureSnapshotV3({
      schemaVersion: 3,
      architectureSnapshotId: text(row.architecture_snapshot_id),
      taskId: text(row.task_id),
      templateId: text(row.template_id),
      templateVersionId: text(row.template_version_id),
      templateDefinitionHash: text(row.template_definition_hash),
      definition,
      taskInputValues: decodeJson<unknown>(row.task_input_values_json),
      taskTitle: text(row.task_title),
      taskGoal: text(row.task_goal),
      taskGoalContent: text(row.task_goal_content),
      taskGoalContentDigest: text(row.task_goal_content_digest),
      taskGoalCompilerVersion: text(row.task_goal_compiler_version),
      workspace: decodeJson<unknown>(row.workspace_json),
      createdAt: text(row.created_at),
    });
  }
  return validateTaskArchitectureSnapshotV2({
    architectureSnapshotId: text(row.architecture_snapshot_id), taskId: text(row.task_id), templateId: text(row.template_id),
    templateVersionId: text(row.template_version_id), templateDefinitionHash: text(row.template_definition_hash),
    definition,
    taskInputValues: decodeJson<TaskArchitectureSnapshotV2["taskInputValues"]>(row.task_input_values_json),
    taskGoalContent: text(row.task_goal_content),
    taskGoalContentDigest: text(row.task_goal_content_digest),
    taskGoalCompilerVersion: text(row.task_goal_compiler_version) as TaskArchitectureSnapshotV2["taskGoalCompilerVersion"],
    workspace: decodeJson<TaskArchitectureSnapshotV2["workspace"]>(row.workspace_json),
    createdAt: text(row.created_at),
  });
}

function validateTaskArchitectureSnapshotV2(value: TaskArchitectureSnapshotV2): TaskArchitectureSnapshotV2 {
  const definition = validateTemplateDefinition(value.definition);
  const workspace = value.workspace;
  if (!workspace || typeof workspace.workspaceId !== "string" || !workspace.workspaceId.startsWith("workspace_")
    || typeof workspace.cwd !== "string" || !workspace.cwd.trim()) {
    throw new Error("runtime_store_task_architecture_v2_workspace_invalid");
  }
  if (value.templateDefinitionHash !== hashDefinition(definition as unknown as JsonValue)) {
    throw new Error("runtime_store_task_architecture_definition_hash_mismatch");
  }
  return Object.freeze({ ...value, definition, workspace: Object.freeze({ ...workspace }) });
}

function toWorkspaceAuthorization(row: Row): WorkspaceAuthorizationRecord {
  return {
    workspaceId: text(row.workspace_id),
    canonicalDirectory: text(row.canonical_directory),
    displayName: text(row.display_name),
    authorizedAt: text(row.authorized_at),
  };
}

function toRun(row: Row): TaskRunRecord {
  return compact({ runId: text(row.run_id), taskId: text(row.task_id), conductorLogicalSessionId: text(row.conductor_logical_session_id), status: text(row.status) as TaskRunRecord["status"], runNumber: number(row.run_number), startedAt: text(row.started_at), endedAt: optionalText(row.ended_at), revision: number(row.revision) });
}

function toStoredCommand(row: Row): StoredCommand {
  return {
    commandId: text(row.command_id),
    commandType: text(row.command_type),
    payloadFingerprint: text(row.payload_fingerprint),
    result: decodeJson<RuntimeCommandResult>(row.result_json),
    acceptedAt: text(row.accepted_at),
  };
}

/**
 * Inserts may be replayed after a Provider reconnect. Reusing an ID with the
 * same immutable data is safe; reusing it for different content is never a
 * hidden update.
 */
function assertSameDurableValue(existing: unknown, incoming: unknown, errorCode: string): void {
  const canonicalExisting = canonicalJson(JSON.parse(encodeJson(existing)));
  const canonicalIncoming = canonicalJson(JSON.parse(encodeJson(incoming)));
  if (canonicalExisting !== canonicalIncoming) throw new Error(errorCode);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("runtime_store_expected_text");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value);
}

function binary(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("runtime_store_expected_binary");
}

function number(value: unknown): number {
  if (typeof value !== "number") throw new Error("runtime_store_expected_number");
  return value;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function insertTemplateAssets(store: SqliteRuntimeStore, templateVersionId: string, assets: readonly TemplateAssetRecord[]): void {
  assertTemplateAssets(assets, templateVersionId);
  for (const asset of assets) {
    store.run(
      `INSERT INTO template_assets(template_version_id, asset_path, content_type, byte_length, content_digest, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      templateVersionId,
      asset.path,
      asset.contentType ?? null,
      asset.byteLength,
      asset.contentDigest,
      Uint8Array.from(asset.bytes),
      asset.createdAt,
    );
  }
}

/**
 * A manifest hash is the ordinary fast path, but bytes are compared as well
 * before a retry is accepted. This keeps a hash collision or a malformed
 * internal call from being silently treated as the immutable original.
 */
function sameTemplateAssets(store: SqliteRuntimeStore, templateVersionId: string, expected: readonly TemplateAssetRecord[]): boolean {
  try {
    // A retry is prepared with a fresh prospective Version ID by the
    // application, so its assets must be compared by immutable payload rather
    // than that unpublished ID.
    assertTemplateAssets(expected);
  } catch {
    return false;
  }
  const stored = store.many<Row>(
    "SELECT template_version_id, asset_path, content_type, byte_length, content_digest, bytes, created_at FROM template_assets WHERE template_version_id = ? ORDER BY asset_path",
    templateVersionId,
  ).map(toTemplateAsset);
  const normalizedExpected = [...expected].sort((left, right) => left.path.localeCompare(right.path));
  if (stored.length !== normalizedExpected.length) return false;
  return stored.every((asset, index) => {
    const candidate = normalizedExpected[index]!;
    return asset.path === candidate.path
      && asset.contentType === candidate.contentType
      && asset.byteLength === candidate.byteLength
      && asset.contentDigest === candidate.contentDigest
      && sameBytes(asset.bytes, candidate.bytes);
  });
}

function assertTemplateAssets(assets: readonly TemplateAssetRecord[], requiredTemplateVersionId?: string): void {
  const paths = new Set<string>();
  for (const asset of assets) {
    if (requiredTemplateVersionId && asset.templateVersionId !== requiredTemplateVersionId) {
      throw new Error("template_asset_version_mismatch");
    }
    if (!asset.path || paths.has(asset.path)) throw new Error("template_asset_path_conflict");
    if (!(asset.bytes instanceof Uint8Array) || asset.bytes.byteLength !== asset.byteLength || asset.byteLength < 0) {
      throw new Error("template_asset_bytes_invalid");
    }
    if (!asset.contentDigest) throw new Error("template_asset_digest_invalid");
    paths.add(asset.path);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
