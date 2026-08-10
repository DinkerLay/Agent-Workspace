import {
  type ArtifactReference,
  type AttentionRecord,
  canonicalJson,
  type InputSubmissionRecord,
  type InvocationRecord,
  type HumanInterventionRecord,
  type JsonObject,
  type JsonValue,
  type LogicalSessionRecord,
  type MetaMessageRecord,
  type MetaMessageId,
  type MetaPatchProposalRecord,
  type MetaPatchProposalId,
  type MetaProfileDefinition,
  type MetaSessionRecord,
  type MetaSessionId,
  type MetaSessionMode,
  type MetaTurnId,
  type MetaTurnReadModel,
  type MetaTurnStatus,
  type ManagedArtifactReadModel,
  type MessageForwardBatchRecord,
  type MessageForwardRecord,
  type ProviderFact,
  providerFactDedupKey,
  providerFactFingerprint,
  type ProviderSessionBindingRecord,
  type RelayBlockRecord,
  type RuntimeReadModel,
  type RuntimeReadRequest,
  type RuntimeCommandId,
  type RuntimeCommandResult,
  type SessionInboxItemRecord,
  type SessionMessageRecord,
  type SessionPresentation,
  type SessionTurnRecord,
  type TaskArchitectureSnapshot,
  type TaskPermanentDeleteResult,
  type TaskRecord,
  type TaskRunRecord,
  type TaskSetupDraftRecord,
  type TemplateDefinition,
  EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
  type TemplateAssetRecord,
  type TemplateDraftRecord,
  type TemplatePackage,
  type TemplateRecord,
  type TemplateSelectionReadModel,
  type TemplateVersionReadModel,
  type TemplateVersionRecord,
  type WorkspaceAuthorizationRecord,
  hashDefinition,
} from "@agent-workspace/runtime-contracts";
import { artifactDisplayName, deriveProviderActivities, deriveTaskTimeline } from "@agent-workspace/runtime-domain";
import { decodeJson, encodeJson, SqliteRuntimeStore } from "./sqlite.js";

export type OutboxRecord = {
  readonly outboxId: string;
  readonly commandId: string;
  readonly provider: string;
  readonly kind: "ensure_binding" | "submit_delivery" | "request_interrupt" | "respond_attention" | "release_binding";
  readonly bindingId?: string;
  readonly payload: JsonObject;
  readonly state: "pending" | "leased" | "effect_accepted" | "effect_rejected" | "unknown";
  readonly attempts: number;
  readonly leaseUntil?: string;
  readonly lastEffect?: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type MetaTurnDispatchStatus = "pending" | "provider_accepted" | "ambiguous";

/** Configuration-owned Provider intent. It is never a Task Binding or ProviderFact. */
export type MetaTurnRecord = {
  readonly metaTurnId: MetaTurnId;
  readonly metaSessionId: MetaSessionId;
  readonly commandId: RuntimeCommandId;
  readonly idempotencyKey: string;
  readonly userMetaMessageId: MetaMessageId;
  readonly assistantMetaMessageId: MetaMessageId;
  readonly metaPatchProposalId: MetaPatchProposalId;
  readonly profile: MetaProfileDefinition;
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

export type CreateMetaTurnStorageInput = Readonly<{
  session: MetaSessionRecord;
  expectedSessionRevision: number;
  userMessage: MetaMessageRecord;
  turn: MetaTurnRecord;
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
  session: MetaSessionRecord;
  expectedSessionRevision: number;
  assistantMessage: MetaMessageRecord;
  proposal?: MetaPatchProposalRecord;
  completedAt: string;
}>;

export type CreateTaskStorageInput = {
  readonly task: TaskRecord;
  readonly snapshot: TaskArchitectureSnapshot;
};

export type StartRunStorageInput = {
  readonly task: TaskRecord;
  readonly run: TaskRunRecord;
  readonly conductor: LogicalSessionRecord;
  readonly binding: ProviderSessionBindingRecord;
  readonly outbox: OutboxRecord;
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
    packageValue: TemplatePackage,
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
  readonly startRun: (input: StartRunStorageInput) => void;
  readonly getRun: (runId: string) => TaskRunRecord | undefined;
  readonly updateRun: (run: TaskRunRecord) => void;
  readonly countRuns: (taskId: string) => number;
}

export interface BindingStore {
  readonly createLogicalSession: (session: LogicalSessionRecord) => void;
  readonly getLogicalSession: (logicalSessionId: string) => LogicalSessionRecord | undefined;
  readonly findLogicalSession: (runId: string, agentCardId: string) => LogicalSessionRecord | undefined;
  readonly listLogicalSessions: (runId: string) => readonly LogicalSessionRecord[];
  readonly updateLogicalSession: (session: LogicalSessionRecord) => void;
  readonly createBinding: (binding: ProviderSessionBindingRecord) => void;
  readonly getBinding: (bindingId: string) => ProviderSessionBindingRecord | undefined;
  readonly findBindingForLogicalSession: (logicalSessionId: string) => ProviderSessionBindingRecord | undefined;
  readonly listBindings: (runId: string) => readonly ProviderSessionBindingRecord[];
  readonly listObservableBindings: () => readonly ProviderSessionBindingRecord[];
  readonly updateBinding: (binding: ProviderSessionBindingRecord) => void;
}

export interface InvocationStore {
  readonly createInput: (input: InputSubmissionRecord, commandId: string) => void;
  readonly getInput: (inputSubmissionId: string) => InputSubmissionRecord | undefined;
  readonly findInputByCommandId: (commandId: string) => InputSubmissionRecord | undefined;
  readonly listInputs: (runId: string) => readonly InputSubmissionRecord[];
  readonly updateInput: (input: InputSubmissionRecord) => void;
  readonly createInvocation: (invocation: InvocationRecord) => void;
  readonly getInvocation: (invocationId: string) => InvocationRecord | undefined;
  readonly listInvocations: (runId: string) => readonly InvocationRecord[];
  readonly updateInvocation: (invocation: InvocationRecord) => void;
  readonly createAttention: (attention: AttentionRecord) => void;
  readonly getAttention: (attentionId: string) => AttentionRecord | undefined;
  readonly listAttentions: (runId: string) => readonly AttentionRecord[];
  readonly updateAttention: (attention: AttentionRecord) => void;
  readonly enqueue: (outbox: OutboxRecord) => void;
  readonly claimOutbox: (now: string, leaseUntil: string) => OutboxRecord | undefined;
  readonly settleOutbox: (outboxId: string, state: OutboxRecord["state"], lastEffect?: JsonObject) => void;
}

/** The Message service is the sole writer of immutable collaboration content. */
export interface MessageStore {
  readonly createMessage: (message: SessionMessageRecord) => void;
  readonly getMessage: (messageId: string) => SessionMessageRecord | undefined;
  /** Used to make ProviderFact replay unable to create a second final message. */
  readonly findMessageByInvocation: (invocationId: string, kind?: SessionMessageRecord["kind"]) => SessionMessageRecord | undefined;
  readonly listMessages: (runId: string) => readonly SessionMessageRecord[];
  readonly listMessagesFromSession: (logicalSessionId: string) => readonly SessionMessageRecord[];
  readonly createRelayBlock: (relayBlock: RelayBlockRecord) => void;
  readonly getRelayBlock: (relayBlockId: string) => RelayBlockRecord | undefined;
  readonly listRelayBlocks: (runId: string) => readonly RelayBlockRecord[];
  readonly listRelayBlocksForMessage: (messageId: string) => readonly RelayBlockRecord[];
}

/** Message service owns explicit cross-Session disclosure audit. */
export interface ForwardStore {
  readonly createForward: (forward: MessageForwardRecord) => void;
  readonly getForward: (forwardId: string) => MessageForwardRecord | undefined;
  readonly findForwardByTargetKey: (taskId: string, runId: string, idempotencyKey: string, targetLogicalSessionId: string) => MessageForwardRecord | undefined;
  readonly listForwards: (runId: string) => readonly MessageForwardRecord[];
  readonly createBatch: (batch: MessageForwardBatchRecord) => void;
  readonly getBatch: (publishBatchId: string) => MessageForwardBatchRecord | undefined;
  readonly findBatchByIdempotencyKey: (taskId: string, runId: string, idempotencyKey: string) => MessageForwardBatchRecord | undefined;
  readonly findBatchByFanoutKey: (taskId: string, runId: string, fanoutKey: string) => MessageForwardBatchRecord | undefined;
  readonly listBatches: (runId: string) => readonly MessageForwardBatchRecord[];
  readonly updateBatch: (batch: MessageForwardBatchRecord) => void;
}

/** Human Intervention service is the only writer of authenticated human provenance. */
export interface HumanInterventionStore {
  readonly createIntervention: (intervention: HumanInterventionRecord) => void;
  readonly getIntervention: (humanInterventionId: string) => HumanInterventionRecord | undefined;
  readonly findInterventionByIdempotencyKey: (taskId: string, runId: string, idempotencyKey: string) => HumanInterventionRecord | undefined;
  readonly listInterventions: (runId: string) => readonly HumanInterventionRecord[];
  readonly updateIntervention: (intervention: HumanInterventionRecord) => void;
}

/** Turn Coordinator is the sole writer of managed Provider-turn provenance. */
export interface SessionTurnStore {
  readonly createTurn: (turn: SessionTurnRecord) => void;
  readonly getTurn: (sessionTurnId: string) => SessionTurnRecord | undefined;
  readonly findTurnByInput: (inputSubmissionId: string) => SessionTurnRecord | undefined;
  readonly listTurns: (runId: string) => readonly SessionTurnRecord[];
  readonly listTurnsForSession: (logicalSessionId: string) => readonly SessionTurnRecord[];
  readonly updateTurn: (turn: SessionTurnRecord) => void;
}

/** Invocation Coordinator owns durable delivery intent and its short lease. */
export interface InboxStore {
  readonly createInboxItem: (item: SessionInboxItemRecord) => void;
  readonly getInboxItem: (inboxItemId: string) => SessionInboxItemRecord | undefined;
  readonly findInboxItem: (input: {
    readonly targetLogicalSessionId: string;
    readonly renderedMessageId: string;
  }) => SessionInboxItemRecord | undefined;
  readonly listInboxItems: (runId: string) => readonly SessionInboxItemRecord[];
  readonly listInboxItemsForSession: (logicalSessionId: string) => readonly SessionInboxItemRecord[];
  readonly updateInboxItem: (item: SessionInboxItemRecord, expectedRevision: number) => void;
  readonly claimInboxItem: (input: {
    readonly inboxItemId: string;
    readonly expectedRevision: number;
    readonly leaseId: string;
    readonly leaseExpiresAt: string;
    readonly now: string;
  }) => SessionInboxItemRecord;
}

export interface ProviderFactStore {
  /** Returns false for an observed duplicate; no domain conclusion is made here. */
  readonly recordFact: (fact: ProviderFact, receivedAt: string) => boolean;
  /**
   * Returns durable Adapter observations for the selected bindings only.  The
   * read-model projection deliberately normalizes them before renderer use.
   */
  readonly listFacts: (bindingIds: readonly string[]) => readonly ProviderFact[];
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

export interface ArtifactStore {
  readonly recordArtifact: (artifact: ArtifactReference) => ArtifactReference;
  readonly listArtifacts: (runId: string) => readonly ArtifactReference[];
  readonly listArtifactsForTask: (taskId: string) => readonly ArtifactReference[];
  readonly getArtifact: (artifactId: string) => ArtifactReference | undefined;
  readonly findArtifactByClaim: (sourceMessageId: string, workspaceRelativePath: string) => ArtifactReference | undefined;
}

/** Durable delete intent is internal Runtime state, never a Renderer projection. */
export type TaskPermanentDeleteIntent = {
  readonly commandId: string;
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly artifactIds: readonly string[];
  readonly payloadFingerprint: string;
  readonly preparedAt: string;
};

export type TaskPermanentDeleteTombstone = {
  readonly commandId: string;
  readonly taskId: string;
  readonly payloadFingerprint: string;
  readonly result: TaskPermanentDeleteResult;
  readonly deletedAt: string;
};

/**
 * Task/Run persistence owns the deletion fence and row cascade. The Host owns
 * filesystem effects, and Runtime Application coordinates the two around this
 * intent; no caller receives raw paths from this capability.
 */
export interface TaskRetentionStore {
  readonly getPermanentDeleteIntent: (commandId: string) => TaskPermanentDeleteIntent | undefined;
  readonly getPermanentDeleteIntentForTask: (taskId: string) => TaskPermanentDeleteIntent | undefined;
  readonly getPermanentDeleteTombstone: (commandId: string) => TaskPermanentDeleteTombstone | undefined;
  readonly preparePermanentDelete: (intent: TaskPermanentDeleteIntent) => TaskPermanentDeleteIntent;
  readonly completePermanentDelete: (input: {
    readonly commandId: string;
    readonly taskId: string;
    readonly payloadFingerprint: string;
    readonly result: TaskPermanentDeleteResult;
  }) => TaskPermanentDeleteTombstone;
}

export interface PresentationStore {
  readonly savePresentation: (presentation: SessionPresentation) => void;
  readonly getPresentation: (presentationLeaseId: string) => SessionPresentation | undefined;
  readonly revokePresentation: (presentationLeaseId: string, revokedAt: string) => SessionPresentation;
  readonly listPresentations: (bindingIds: readonly string[], now: string) => readonly SessionPresentation[];
}

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
  readonly createMetaSession: (session: MetaSessionRecord) => void;
  readonly getMetaSession: (metaSessionId: string) => MetaSessionRecord | undefined;
  readonly findActiveMetaSession: (ownerId: string, target: MetaSessionRecord["target"]) => MetaSessionRecord | undefined;
  readonly listMetaSessions: () => readonly MetaSessionRecord[];
  readonly updateMetaSession: (session: MetaSessionRecord, expectedRevision: number) => void;
  readonly createMetaMessage: (message: MetaMessageRecord) => void;
  readonly getMetaMessage: (metaMessageId: string) => MetaMessageRecord | undefined;
  readonly listMetaMessages: (metaSessionId?: string) => readonly MetaMessageRecord[];
  readonly createMetaPatchProposal: (proposal: MetaPatchProposalRecord) => void;
  readonly getMetaPatchProposal: (metaPatchProposalId: string) => MetaPatchProposalRecord | undefined;
  readonly listMetaPatchProposals: (metaSessionId?: string) => readonly MetaPatchProposalRecord[];
  readonly updateMetaPatchProposal: (proposal: MetaPatchProposalRecord, expectedRevision: number) => void;
  readonly createMetaMessageAndTurn: (input: CreateMetaTurnStorageInput) => MetaTurnRecord;
  readonly getMetaTurn: (metaTurnId: MetaTurnId) => MetaTurnRecord | undefined;
  readonly listMetaTurns: (metaSessionId?: MetaSessionId) => readonly MetaTurnRecord[];
  readonly claimMetaTurn: (now: string, leaseUntil: string) => MetaTurnRecord | undefined;
  readonly releaseMetaTurn: (metaTurnId: MetaTurnId, expectedAttempts: number, now: string) => MetaTurnRecord;
  readonly settleMetaTurn: (input: SettleMetaTurnStorageInput) => MetaTurnRecord;
  readonly completeMetaTurn: (input: CompleteMetaTurnStorageInput) => MetaTurnRecord;
}

export interface RuntimeReadStore {
  readonly readModel: (now: string, request?: RuntimeReadRequest) => RuntimeReadModel;
}

export interface RuntimeRepositories {
  readonly transaction: <T>(work: () => T) => T;
  readonly templateTask: TemplateTaskStore;
  readonly binding: BindingStore;
  readonly message: MessageStore;
  readonly forward: ForwardStore;
  readonly humanIntervention: HumanInterventionStore;
  readonly inbox: InboxStore;
  readonly turn: SessionTurnStore;
  readonly invocation: InvocationStore;
  readonly providerFact: ProviderFactStore;
  readonly command: CommandStore;
  readonly artifact: ArtifactStore;
  readonly retention: TaskRetentionStore;
  readonly presentation: PresentationStore;
  readonly workspace: WorkspaceAuthorizationStore;
  readonly configuration: ConfigurationStore;
  readonly read: RuntimeReadStore;
}

/**
 * Store capabilities are deliberately split by writer. A composition root gives
 * each service only the matching member rather than this whole object.
 */
export function createRuntimeRepositories(store: SqliteRuntimeStore): RuntimeRepositories {
  const templateTask: TemplateTaskStore = {
    createDraft(draft) {
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
      const previous = store.one<Row>("SELECT revision FROM template_design_sessions WHERE draft_id = ?", draft.templateDraftId);
      if (!previous) throw new Error("template_draft_not_found");
      if (number(previous.revision) !== expectedRevision) throw new Error("stale_template_draft_revision");
      store.run(
        `UPDATE template_design_sessions SET metadata_json = ?, definition_json = ?, status = ?, revision = ?, updated_at = ? WHERE draft_id = ?`,
        encodeJson(draft.metadata), encodeJson(draft.definition), draft.status, draft.revision, draft.updatedAt, draft.templateDraftId,
      );
    },
    publishDraft(template, version, draft, expectedRevision) {
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
      return store.transaction(() => {
        const assetManifestHash = version.assetManifestHash ?? EMPTY_TEMPLATE_ASSET_MANIFEST_HASH;
        const packageAssetManifestHash = packageValue.template.assetManifestHash ?? EMPTY_TEMPLATE_ASSET_MANIFEST_HASH;
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
          encodeJson(packageValue.definition), version.definitionHash, assetManifestHash, version.createdAt, version.publishedAt,
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
      store.transaction(() => {
        store.run(
          `INSERT INTO task_architecture_snapshots(architecture_snapshot_id, task_id, template_id, template_version_id, template_definition_hash, definition_json, task_input_values_json, task_goal_content, task_goal_content_digest, task_goal_compiler_version, workspace_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          snapshot.architectureSnapshotId, snapshot.taskId, snapshot.templateId, snapshot.templateVersionId,
          snapshot.templateDefinitionHash, encodeJson(snapshot.definition), encodeJson(snapshot.taskInputValues),
          snapshot.taskGoalContent, snapshot.taskGoalContentDigest, snapshot.taskGoalCompilerVersion,
          encodeJson(snapshot.workspace), snapshot.createdAt,
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
      const row = store.one<Row>("SELECT * FROM task_architecture_snapshots WHERE task_id = ?", taskId);
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
    startRun({ task, run, conductor, binding, outbox }) {
      store.transaction(() => {
        const row = store.one<Row>("SELECT revision FROM tasks WHERE task_id = ?", task.taskId);
        if (!row || number(row.revision) + 1 !== task.revision) throw new Error("stale_task_revision");
        store.run(
          `INSERT INTO task_runs(run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          run.runId, run.taskId, run.conductorLogicalSessionId, run.status, run.runNumber, run.revision, run.startedAt, run.endedAt ?? null,
        );
        insertSession(store, conductor);
        insertBinding(store, binding);
        insertOutbox(store, outbox);
        store.run("UPDATE tasks SET status = ?, active_run_id = ?, revision = ?, updated_at = ? WHERE task_id = ?", task.status, task.activeRunId ?? null, task.revision, task.updatedAt, task.taskId);
      });
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
      const row = store.one<Row>("SELECT revision FROM meta_sessions WHERE meta_session_id = ?", session.metaSessionId);
      if (!row) throw new Error("meta_session_not_found");
      if (number(row.revision) !== expectedRevision) throw new Error("stale_meta_session_revision");
      store.run(
        "UPDATE meta_sessions SET state = ?, revision = ?, updated_at = ? WHERE meta_session_id = ?",
        session.state,
        session.revision,
        session.updatedAt,
        session.metaSessionId,
      );
    },
    createMetaMessage(message) {
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
      const row = store.one<Row>("SELECT revision FROM meta_patch_proposals WHERE meta_patch_proposal_id = ?", proposal.metaPatchProposalId);
      if (!row) throw new Error("meta_patch_proposal_not_found");
      if (number(row.revision) !== expectedRevision) throw new Error("stale_meta_patch_proposal_revision");
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
          const existing = collisions[0]!;
          assertSameMetaTurnIntent(existing, input.turn);
          const existingMessage = this.getMetaMessage(existing.userMetaMessageId);
          if (!existingMessage) throw new Error("meta_turn_user_message_missing");
          assertSameDurableValue(existingMessage, input.userMessage, "meta_turn_user_message_conflict");
          return existing;
        }
        const currentSession = this.getMetaSession(input.session.metaSessionId);
        if (!currentSession) throw new Error("meta_session_not_found");
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
        const row = store.one<Row>(
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
           LIMIT 1`,
          now,
        );
        if (!row) return undefined;
        const current = toMetaTurn(row);
        const leasedFromStatus = current.status === "leased" ? current.leasedFromStatus : current.status;
        if (!isMetaTurnDispatchStatus(leasedFromStatus)) throw new Error("meta_turn_lease_origin_invalid");
        const claimed: MetaTurnRecord = {
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
        const current = requiredMetaTurn(store, metaTurnId);
        if (
          isMetaTurnDispatchStatus(current.status)
          && current.attempts === expectedAttempts
          && current.leaseUntil === undefined
          && current.leasedFromStatus === undefined
        ) return current;
        if (current.status !== "leased") throw new Error("meta_turn_not_leased");
        if (current.attempts !== expectedAttempts) throw new Error("stale_meta_turn_attempt");
        if (!isMetaTurnDispatchStatus(current.leasedFromStatus)) throw new Error("meta_turn_lease_origin_invalid");
        const released: MetaTurnRecord = {
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
        const current = requiredMetaTurn(store, input.metaTurnId);
        if (
          current.status === input.status
          && current.attempts === input.expectedAttempts
          && current.failureCode === input.failureCode
          && current.leaseUntil === undefined
        ) return current;
        if (current.status !== "leased") throw new Error("meta_turn_not_leased");
        if (current.attempts !== input.expectedAttempts) throw new Error("stale_meta_turn_attempt");
        const settled: MetaTurnRecord = {
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
        const current = requiredMetaTurn(store, input.metaTurnId);
        if (current.status === "returned") {
          assertCompletedMetaTurnReplay(this, current, input);
          return current;
        }
        if (current.status !== "leased") throw new Error("meta_turn_not_leased");
        if (current.attempts !== input.expectedAttempts) throw new Error("stale_meta_turn_attempt");
        assertMetaTurnCompletion(current, input);
        const storedSession = this.getMetaSession(input.session.metaSessionId);
        if (!storedSession) throw new Error("meta_session_not_found");
        if (storedSession.revision !== input.expectedSessionRevision) throw new Error("stale_meta_session_revision");
        this.createMetaMessage(input.assistantMessage);
        if (input.proposal) this.createMetaPatchProposal(input.proposal);
        this.updateMetaSession(input.session, input.expectedSessionRevision);
        const returned: MetaTurnRecord = {
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

  const binding: BindingStore = {
    createLogicalSession(session) { insertSession(store, session); },
    getLogicalSession(logicalSessionId) {
      const row = store.one<Row>("SELECT * FROM logical_sessions WHERE logical_session_id = ?", logicalSessionId);
      return row ? toLogicalSession(row) : undefined;
    },
    findLogicalSession(runId, agentCardId) {
      const row = store.one<Row>("SELECT * FROM logical_sessions WHERE run_id = ? AND agent_card_id = ?", runId, agentCardId);
      return row ? toLogicalSession(row) : undefined;
    },
    listLogicalSessions(runId) {
      return store.many<Row>("SELECT * FROM logical_sessions WHERE run_id = ? ORDER BY ordinal", runId).map(toLogicalSession);
    },
    updateLogicalSession(session) {
      store.run("UPDATE logical_sessions SET status = ?, updated_at = ? WHERE logical_session_id = ?", session.status, session.updatedAt, session.logicalSessionId);
    },
    createBinding(bindingRecord) { insertBinding(store, bindingRecord); },
    getBinding(bindingId) {
      const row = store.one<Row>("SELECT * FROM provider_session_bindings WHERE binding_id = ?", bindingId);
      return row ? toBinding(row) : undefined;
    },
    findBindingForLogicalSession(logicalSessionId) {
      const row = store.one<Row>("SELECT * FROM provider_session_bindings WHERE logical_session_id = ? ORDER BY created_at DESC LIMIT 1", logicalSessionId);
      return row ? toBinding(row) : undefined;
    },
    listBindings(runId) {
      return store.many<Row>("SELECT * FROM provider_session_bindings WHERE run_id = ? ORDER BY created_at", runId).map(toBinding);
    },
    listObservableBindings() {
      return store.many<Row>(
        "SELECT * FROM provider_session_bindings WHERE status IN ('binding_effect_accepted', 'recovering', 'active') ORDER BY updated_at",
      ).map(toBinding);
    },
    updateBinding(bindingRecord) {
      store.run(
        `UPDATE provider_session_bindings SET provider_host_id = ?, native_binding_ref = ?, binding_revision = ?, status = ?, recoverable = ?, updated_at = ? WHERE binding_id = ?`,
        bindingRecord.providerHostId ?? null, bindingRecord.nativeBindingRef ?? null, bindingRecord.bindingRevision,
        bindingRecord.status, bindingRecord.recoverable ? 1 : 0, bindingRecord.updatedAt, bindingRecord.bindingId,
      );
    },
  };

  const message: MessageStore = {
    createMessage(value) {
      if (value.kind === "task_goal") {
        if (value.taskGoalCompilerVersion !== "task-goal/v1") throw new Error("task_goal_compiler_version_required");
      } else if (value.taskGoalCompilerVersion !== undefined) {
        throw new Error("task_goal_compiler_version_not_allowed");
      }
      const currentRow = store.one<Row>("SELECT * FROM session_messages WHERE message_id = ?", value.messageId);
      if (currentRow) {
        assertSameDurableValue(toSessionMessage(currentRow), value, "session_message_id_conflict");
        return;
      }
      if (value.kind === "agent_final" && value.invocationId) {
        const existingFinal = store.one<Row>(
          "SELECT * FROM session_messages WHERE invocation_id = ? AND kind = ? LIMIT 1",
          value.invocationId,
          "agent_final",
        );
        if (existingFinal) throw new Error("agent_final_invocation_conflict");
      }
      store.run(
        `INSERT INTO session_messages(message_id, task_id, run_id, source_logical_session_id, source_session_turn_id, source_human_intervention_id, invocation_id, kind, content, content_digest, task_goal_compiler_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.messageId,
        value.taskId,
        value.runId,
        value.sourceLogicalSessionId ?? null,
        value.sourceSessionTurnId ?? null,
        value.sourceHumanInterventionId ?? null,
        value.invocationId ?? null,
        value.kind,
        value.content,
        value.contentDigest,
        value.taskGoalCompilerVersion ?? null,
        value.createdAt,
      );
    },
    getMessage(messageId) {
      const row = store.one<Row>("SELECT * FROM session_messages WHERE message_id = ?", messageId);
      return row ? toSessionMessage(row) : undefined;
    },
    findMessageByInvocation(invocationId, kind) {
      const row = kind
        ? store.one<Row>("SELECT * FROM session_messages WHERE invocation_id = ? AND kind = ? ORDER BY created_at, message_id LIMIT 1", invocationId, kind)
        : store.one<Row>("SELECT * FROM session_messages WHERE invocation_id = ? ORDER BY created_at, message_id LIMIT 1", invocationId);
      return row ? toSessionMessage(row) : undefined;
    },
    listMessages(runId) {
      return store.many<Row>("SELECT * FROM session_messages WHERE run_id = ? ORDER BY created_at, message_id", runId).map(toSessionMessage);
    },
    listMessagesFromSession(logicalSessionId) {
      return store.many<Row>("SELECT * FROM session_messages WHERE source_logical_session_id = ? ORDER BY created_at, message_id", logicalSessionId)
        .map(toSessionMessage);
    },
    createRelayBlock(value) {
      const currentRow = store.one<Row>("SELECT * FROM relay_blocks WHERE relay_block_id = ?", value.relayBlockId);
      if (currentRow) {
        assertSameDurableValue(toRelayBlock(currentRow), value, "relay_block_id_conflict");
        return;
      }
      const existingOrdinal = store.one<Row>("SELECT * FROM relay_blocks WHERE source_message_id = ? AND ordinal = ?", value.sourceMessageId, value.ordinal);
      if (existingOrdinal) {
        assertSameDurableValue(toRelayBlock(existingOrdinal), value, "relay_block_source_ordinal_conflict");
        return;
      }
      store.run(
        `INSERT INTO relay_blocks(relay_block_id, source_message_id, ordinal, suggested_target_agent_card_ids_json, suggested_audience, topic, format, content, content_digest, parser_version, source_start, source_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.relayBlockId,
        value.sourceMessageId,
        value.ordinal,
        encodeJson(value.suggestedTargetAgentCardIds),
        value.suggestedAudience ?? null,
        value.topic ?? null,
        value.format,
        value.content,
        value.contentDigest,
        value.parserVersion,
        value.sourceRange.start,
        value.sourceRange.end,
        value.createdAt,
      );
    },
    getRelayBlock(relayBlockId) {
      const row = store.one<Row>("SELECT * FROM relay_blocks WHERE relay_block_id = ?", relayBlockId);
      return row ? toRelayBlock(row) : undefined;
    },
    listRelayBlocks(runId) {
      return store.many<Row>(
        `SELECT relay_blocks.*
         FROM relay_blocks
         JOIN session_messages ON session_messages.message_id = relay_blocks.source_message_id
         WHERE session_messages.run_id = ?
         ORDER BY session_messages.created_at, relay_blocks.ordinal`,
        runId,
      ).map(toRelayBlock);
    },
    listRelayBlocksForMessage(messageId) {
      return store.many<Row>("SELECT * FROM relay_blocks WHERE source_message_id = ? ORDER BY ordinal", messageId).map(toRelayBlock);
    },
  };

  const forward: ForwardStore = {
    createForward(value) {
      const existing = this.getForward(value.forwardId);
      if (existing) {
        assertSameDurableValue(existing, value, "message_forward_id_conflict");
        return;
      }
      const duplicate = this.findForwardByTargetKey(value.taskId, value.runId, value.idempotencyKey, value.targetLogicalSessionId);
      if (duplicate) {
        assertSameDurableValue(duplicate, value, "message_forward_idempotency_conflict");
        return;
      }
      store.run(
        `INSERT INTO message_forwards(forward_id, task_id, run_id, command_id, idempotency_key, expected_task_revision, publish_batch_id, target_idempotency_key, decided_by_logical_session_id, decided_by_session_turn_id, target_logical_session_id, mode, rendered_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.forwardId,
        value.taskId,
        value.runId,
        value.commandId,
        value.idempotencyKey,
        value.expectedTaskRevision,
        value.publishBatchId ?? null,
        value.targetIdempotencyKey,
        value.decidedByLogicalSessionId,
        value.decidedBySessionTurnId,
        value.targetLogicalSessionId,
        value.mode,
        value.renderedMessageId,
        value.createdAt,
      );
      for (const selection of value.selections) {
        store.run(
          `INSERT INTO message_forward_selections(forward_selection_id, forward_id, ordinal, kind, source_message_id, relay_block_id, content_digest)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          selection.forwardSelectionId,
          selection.forwardId,
          selection.ordinal,
          selection.kind,
          selection.sourceMessageId,
          selection.relayBlockId ?? null,
          selection.contentDigest,
        );
      }
    },
    getForward(forwardId) {
      const row = store.one<Row>("SELECT * FROM message_forwards WHERE forward_id = ?", forwardId);
      return row ? toMessageForward(row, listForwardSelections(store, forwardId)) : undefined;
    },
    findForwardByTargetKey(taskId, runId, idempotencyKey, targetLogicalSessionId) {
      const row = store.one<Row>(
        `SELECT * FROM message_forwards
         WHERE task_id = ? AND run_id = ? AND idempotency_key = ? AND target_logical_session_id = ?`,
        taskId,
        runId,
        idempotencyKey,
        targetLogicalSessionId,
      );
      return row ? toMessageForward(row, listForwardSelections(store, text(row.forward_id))) : undefined;
    },
    listForwards(runId) {
      return store.many<Row>("SELECT * FROM message_forwards WHERE run_id = ? ORDER BY created_at, forward_id", runId)
        .map((row) => toMessageForward(row, listForwardSelections(store, text(row.forward_id))));
    },
    createBatch(value) {
      const existing = this.getBatch(value.publishBatchId);
      if (existing) {
        assertSameDurableValue(existing, value, "message_forward_batch_id_conflict");
        return;
      }
      const duplicate = this.findBatchByIdempotencyKey(value.taskId, value.runId, value.idempotencyKey);
      if (duplicate) {
        assertSameDurableValue(duplicate, value, "message_forward_batch_idempotency_conflict");
        return;
      }
      store.run(
        `INSERT INTO message_forward_batches(publish_batch_id, task_id, run_id, command_id, idempotency_key, expected_task_revision, fanout_key, decided_by_logical_session_id, decided_by_session_turn_id, target_logical_session_ids_json, selection_digest, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.publishBatchId,
        value.taskId,
        value.runId,
        value.commandId,
        value.idempotencyKey,
        value.expectedTaskRevision,
        value.fanoutKey,
        value.decidedByLogicalSessionId,
        value.decidedBySessionTurnId,
        encodeJson(value.targetLogicalSessionIds),
        value.selectionDigest,
        value.state,
        value.createdAt,
        value.updatedAt,
      );
    },
    getBatch(publishBatchId) {
      const row = store.one<Row>("SELECT * FROM message_forward_batches WHERE publish_batch_id = ?", publishBatchId);
      return row ? toMessageForwardBatch(row) : undefined;
    },
    findBatchByIdempotencyKey(taskId, runId, idempotencyKey) {
      const row = store.one<Row>(
        "SELECT * FROM message_forward_batches WHERE task_id = ? AND run_id = ? AND idempotency_key = ?",
        taskId,
        runId,
        idempotencyKey,
      );
      return row ? toMessageForwardBatch(row) : undefined;
    },
    findBatchByFanoutKey(taskId, runId, fanoutKey) {
      const row = store.one<Row>(
        "SELECT * FROM message_forward_batches WHERE task_id = ? AND run_id = ? AND fanout_key = ?",
        taskId,
        runId,
        fanoutKey,
      );
      return row ? toMessageForwardBatch(row) : undefined;
    },
    listBatches(runId) {
      return store.many<Row>("SELECT * FROM message_forward_batches WHERE run_id = ? ORDER BY created_at, publish_batch_id", runId)
        .map(toMessageForwardBatch);
    },
    updateBatch(value) {
      store.run(
        "UPDATE message_forward_batches SET state = ?, updated_at = ? WHERE publish_batch_id = ?",
        value.state,
        value.updatedAt,
        value.publishBatchId,
      );
    },
  };

  const humanIntervention: HumanInterventionStore = {
    createIntervention(value) {
      const existing = this.getIntervention(value.humanInterventionId);
      if (existing) {
        assertSameDurableValue(existing, value, "human_intervention_id_conflict");
        return;
      }
      const duplicate = this.findInterventionByIdempotencyKey(value.taskId, value.runId, value.idempotencyKey);
      if (duplicate) {
        assertSameDurableValue(duplicate, value, "human_intervention_idempotency_conflict");
        return;
      }
      store.run(
        `INSERT INTO human_interventions(human_intervention_id, task_id, run_id, command_id, idempotency_key, expected_task_revision, target_logical_session_id, content, content_digest, affected_session_turn_id, affected_invocation_id, mode, card_message_id, conductor_mirror_message_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.humanInterventionId,
        value.taskId,
        value.runId,
        value.commandId,
        value.idempotencyKey,
        value.expectedTaskRevision,
        value.targetLogicalSessionId,
        value.content,
        value.contentDigest,
        value.affectedSessionTurnId ?? null,
        value.affectedInvocationId ?? null,
        value.mode,
        value.cardMessageId ?? null,
        value.conductorMirrorMessageId ?? null,
        value.state,
        value.createdAt,
        value.updatedAt,
      );
    },
    getIntervention(humanInterventionId) {
      const row = store.one<Row>("SELECT * FROM human_interventions WHERE human_intervention_id = ?", humanInterventionId);
      return row ? toHumanIntervention(row) : undefined;
    },
    findInterventionByIdempotencyKey(taskId, runId, idempotencyKey) {
      const row = store.one<Row>(
        "SELECT * FROM human_interventions WHERE task_id = ? AND run_id = ? AND idempotency_key = ?",
        taskId,
        runId,
        idempotencyKey,
      );
      return row ? toHumanIntervention(row) : undefined;
    },
    listInterventions(runId) {
      return store.many<Row>("SELECT * FROM human_interventions WHERE run_id = ? ORDER BY created_at, human_intervention_id", runId)
        .map(toHumanIntervention);
    },
    updateIntervention(value) {
      store.run(
        `UPDATE human_interventions SET affected_session_turn_id = ?, affected_invocation_id = ?, mode = ?, card_message_id = ?, conductor_mirror_message_id = ?, state = ?, updated_at = ?
         WHERE human_intervention_id = ?`,
        value.affectedSessionTurnId ?? null,
        value.affectedInvocationId ?? null,
        value.mode,
        value.cardMessageId ?? null,
        value.conductorMirrorMessageId ?? null,
        value.state,
        value.updatedAt,
        value.humanInterventionId,
      );
    },
  };

  const inbox: InboxStore = {
    createInboxItem(value) {
      const currentRow = store.one<Row>("SELECT * FROM session_inbox_items WHERE inbox_item_id = ?", value.inboxItemId);
      if (currentRow) {
        assertSameDurableValue(toSessionInboxItem(currentRow), value, "session_inbox_item_id_conflict");
        return;
      }
      const duplicate = store.one<Row>(
        `SELECT * FROM session_inbox_items
         WHERE target_logical_session_id = ? AND rendered_message_id = ?`,
        value.targetLogicalSessionId,
        value.renderedMessageId,
      );
      if (duplicate) {
        assertSameDurableValue(toSessionInboxItem(duplicate), value, "session_inbox_item_delivery_conflict");
        return;
      }
      store.run(
        `INSERT INTO session_inbox_items(inbox_item_id, task_id, run_id, target_logical_session_id, rendered_message_id, forward_id, human_intervention_id, reply_to_logical_session_id, state, lease_id, lease_expires_at, delivery_input_submission_id, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.inboxItemId,
        value.taskId,
        value.runId,
        value.targetLogicalSessionId,
        value.renderedMessageId,
        value.forwardId ?? null,
        value.humanInterventionId ?? null,
        value.replyToLogicalSessionId ?? null,
        value.state,
        value.leaseId ?? null,
        value.leaseExpiresAt ?? null,
        value.deliveryInputSubmissionId ?? null,
        value.revision,
        value.createdAt,
        value.updatedAt,
      );
    },
    getInboxItem(inboxItemId) {
      const row = store.one<Row>("SELECT * FROM session_inbox_items WHERE inbox_item_id = ?", inboxItemId);
      return row ? toSessionInboxItem(row) : undefined;
    },
    findInboxItem(input) {
      const row = store.one<Row>(
        `SELECT * FROM session_inbox_items
         WHERE target_logical_session_id = ? AND rendered_message_id = ?`,
        input.targetLogicalSessionId,
        input.renderedMessageId,
      );
      return row ? toSessionInboxItem(row) : undefined;
    },
    listInboxItems(runId) {
      return store.many<Row>("SELECT * FROM session_inbox_items WHERE run_id = ? ORDER BY created_at, inbox_item_id", runId).map(toSessionInboxItem);
    },
    listInboxItemsForSession(logicalSessionId) {
      return store.many<Row>("SELECT * FROM session_inbox_items WHERE target_logical_session_id = ? ORDER BY created_at, inbox_item_id", logicalSessionId)
        .map(toSessionInboxItem);
    },
    updateInboxItem(value, expectedRevision) {
      const current = this.getInboxItem(value.inboxItemId);
      if (!current) throw new Error("session_inbox_item_not_found");
      if (current.revision !== expectedRevision) throw new Error("stale_session_inbox_item_revision");
      if (value.revision !== expectedRevision + 1) throw new Error("session_inbox_item_revision_invalid");
      store.run(
        `UPDATE session_inbox_items
         SET state = ?, lease_id = ?, lease_expires_at = ?, delivery_input_submission_id = ?, revision = ?, updated_at = ?
         WHERE inbox_item_id = ? AND revision = ?`,
        value.state,
        value.leaseId ?? null,
        value.leaseExpiresAt ?? null,
        value.deliveryInputSubmissionId ?? null,
        value.revision,
        value.updatedAt,
        value.inboxItemId,
        expectedRevision,
      );
    },
    claimInboxItem(input) {
      const current = this.getInboxItem(input.inboxItemId);
      if (!current) throw new Error("session_inbox_item_not_found");
      if (current.revision !== input.expectedRevision) throw new Error("stale_session_inbox_item_revision");
      if (current.state !== "pending") throw new Error("session_inbox_item_not_pending");
      const claimed: SessionInboxItemRecord = {
        ...current,
        state: "leased",
        leaseId: input.leaseId,
        leaseExpiresAt: input.leaseExpiresAt,
        revision: current.revision + 1,
        updatedAt: input.now,
      };
      this.updateInboxItem(claimed, input.expectedRevision);
      return claimed;
    },
  };

  const invocation: InvocationStore = {
    createInput(input, commandId) {
      store.run(
        `INSERT INTO input_submissions(input_submission_id, source_inbox_item_id, task_id, run_id, logical_session_id, binding_id, content_message_id, delivery_role, command_id, idempotency_key, content_digest, content, sequence_number, status, provider_effect_id, native_message_id, native_turn_id, evidence_reference_id, supersedes_input_submission_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.inputSubmissionId, input.sourceInboxItemId, input.taskId, input.runId, input.logicalSessionId, input.bindingId,
        input.contentMessageId, input.deliveryRole, commandId, input.idempotencyKey, input.contentDigest, input.content, input.sequenceNumber, input.status,
        input.providerEffectId ?? null, input.nativeMessageId ?? null, input.nativeTurnId ?? null,
        input.evidenceReferenceId ?? null, input.supersedesInputSubmissionId ?? null, input.createdAt, input.updatedAt,
      );
    },
    getInput(inputSubmissionId) {
      const row = store.one<Row>("SELECT * FROM input_submissions WHERE input_submission_id = ?", inputSubmissionId);
      return row ? toInput(row) : undefined;
    },
    findInputByCommandId(commandId) {
      const row = store.one<Row>("SELECT * FROM input_submissions WHERE command_id = ?", commandId);
      return row ? toInput(row) : undefined;
    },
    listInputs(runId) {
      return store.many<Row>("SELECT * FROM input_submissions WHERE run_id = ? ORDER BY sequence_number", runId).map(toInput);
    },
    updateInput(input) {
      store.run(
        `UPDATE input_submissions SET status = ?, provider_effect_id = ?, native_message_id = ?, native_turn_id = ?, evidence_reference_id = ?, supersedes_input_submission_id = ?, updated_at = ? WHERE input_submission_id = ?`,
        input.status, input.providerEffectId ?? null, input.nativeMessageId ?? null, input.nativeTurnId ?? null,
        input.evidenceReferenceId ?? null, input.supersedesInputSubmissionId ?? null, input.updatedAt, input.inputSubmissionId,
      );
    },
    createInvocation(invocationRecord) {
      store.run(
        `INSERT INTO invocations(invocation_id, task_id, run_id, target_logical_session_id, target_agent_card_id, binding_id, reply_to_logical_session_id, assignment_message_id, final_message_id, status, instruction, acceptance_criteria_json, requested_artifacts_json, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        invocationRecord.invocationId, invocationRecord.taskId, invocationRecord.runId,
        invocationRecord.targetLogicalSessionId, invocationRecord.targetAgentCardId, invocationRecord.bindingId,
        invocationRecord.replyToLogicalSessionId, invocationRecord.assignmentMessageId, invocationRecord.finalMessageId ?? null,
        invocationRecord.status, invocationRecord.instruction,
        encodeJson(invocationRecord.acceptanceCriteria), encodeJson(invocationRecord.requestedArtifacts),
        invocationRecord.priority ?? null, invocationRecord.createdAt, invocationRecord.updatedAt,
      );
    },
    getInvocation(invocationId) {
      const row = store.one<Row>("SELECT * FROM invocations WHERE invocation_id = ?", invocationId);
      return row ? toInvocation(row) : undefined;
    },
    listInvocations(runId) {
      return store.many<Row>("SELECT * FROM invocations WHERE run_id = ? ORDER BY created_at", runId).map(toInvocation);
    },
    updateInvocation(invocationRecord) {
      store.run(
        "UPDATE invocations SET final_message_id = ?, status = ?, updated_at = ? WHERE invocation_id = ?",
        invocationRecord.finalMessageId ?? null,
        invocationRecord.status,
        invocationRecord.updatedAt,
        invocationRecord.invocationId,
      );
    },
    createAttention(attention) {
      store.run(
        `INSERT INTO attentions(attention_id, task_id, run_id, binding_id, binding_revision, native_request_id, active_input_submission_id, active_invocation_id, request_json, response_json, status, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attention.attentionId, attention.taskId, attention.runId, attention.bindingId, attention.bindingRevision,
        attention.nativeRequestId, attention.activeInputSubmissionId ?? null, attention.activeInvocationId ?? null,
        encodeJson(attention.request), attention.response ? encodeJson(attention.response) : null, attention.status,
        attention.createdAt, attention.updatedAt, attention.status === "resolved" ? attention.updatedAt : null,
      );
    },
    getAttention(attentionId) {
      const row = store.one<Row>("SELECT * FROM attentions WHERE attention_id = ?", attentionId);
      return row ? toAttention(row) : undefined;
    },
    listAttentions(runId) {
      return store.many<Row>("SELECT * FROM attentions WHERE run_id = ? ORDER BY created_at", runId).map(toAttention);
    },
    updateAttention(attention) {
      store.run(
        `UPDATE attentions SET response_json = ?, status = ?, updated_at = ?, resolved_at = ? WHERE attention_id = ?`,
        attention.response ? encodeJson(attention.response) : null, attention.status, attention.updatedAt,
        attention.status === "resolved" ? attention.updatedAt : null, attention.attentionId,
      );
    },
    enqueue(outbox) { insertOutbox(store, outbox); },
    claimOutbox(now, leaseUntil) {
      return store.transaction(() => {
        const row = store.one<Row>(
          `SELECT * FROM outbox WHERE state IN ('pending', 'unknown') AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at LIMIT 1`,
          now,
        );
        if (!row) return undefined;
        const outbox = toOutbox(row);
        store.run("UPDATE outbox SET state = ?, attempts = ?, lease_until = ?, updated_at = ? WHERE outbox_id = ?", "leased", outbox.attempts + 1, leaseUntil, now, outbox.outboxId);
        return { ...outbox, state: "leased" as const, attempts: outbox.attempts + 1, leaseUntil, updatedAt: now };
      });
    },
    settleOutbox(outboxId, state, lastEffect) {
      const now = store.now();
      store.run("UPDATE outbox SET state = ?, lease_until = NULL, last_effect_json = ?, updated_at = ? WHERE outbox_id = ?", state, lastEffect ? encodeJson(lastEffect) : null, now, outboxId);
    },
  };

  const turn: SessionTurnStore = {
    createTurn(value) {
      store.run(
        `INSERT INTO session_turns(session_turn_id, task_id, run_id, input_submission_id, target_logical_session_id, kind, initiator, trigger, reply_to_logical_session_id, invocation_id, human_intervention_id, affected_session_turn_id, final_message_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.sessionTurnId,
        value.taskId,
        value.runId,
        value.inputSubmissionId,
        value.targetLogicalSessionId,
        value.kind,
        value.initiator,
        value.trigger,
        value.replyToLogicalSessionId ?? null,
        value.invocationId ?? null,
        value.humanInterventionId ?? null,
        value.affectedSessionTurnId ?? null,
        value.finalMessageId ?? null,
        value.status,
        value.createdAt,
        value.updatedAt,
      );
    },
    getTurn(sessionTurnId) {
      const row = store.one<Row>("SELECT * FROM session_turns WHERE session_turn_id = ?", sessionTurnId);
      return row ? toSessionTurn(row) : undefined;
    },
    findTurnByInput(inputSubmissionId) {
      const row = store.one<Row>("SELECT * FROM session_turns WHERE input_submission_id = ?", inputSubmissionId);
      return row ? toSessionTurn(row) : undefined;
    },
    listTurns(runId) {
      return store.many<Row>("SELECT * FROM session_turns WHERE run_id = ? ORDER BY created_at, session_turn_id", runId).map(toSessionTurn);
    },
    listTurnsForSession(logicalSessionId) {
      return store.many<Row>("SELECT * FROM session_turns WHERE target_logical_session_id = ? ORDER BY created_at, session_turn_id", logicalSessionId).map(toSessionTurn);
    },
    updateTurn(value) {
      store.run(
        `UPDATE session_turns SET final_message_id = ?, status = ?, updated_at = ? WHERE session_turn_id = ?`,
        value.finalMessageId ?? null,
        value.status,
        value.updatedAt,
        value.sessionTurnId,
      );
    },
  };

  const providerFact: ProviderFactStore = {
    recordFact(fact, receivedAt) {
      const dedupKey = providerFactDedupKey(fact);
      const existing = store.one<Row>("SELECT fact_json FROM provider_facts WHERE binding_id = ? AND dedup_key = ?", fact.bindingId, dedupKey);
      if (existing) {
        const recorded = decodeJson<ProviderFact>(existing.fact_json);
        if (providerFactFingerprint(recorded) !== providerFactFingerprint(fact)) {
          throw new Error("provider_fact_dedup_conflict");
        }
        return false;
      }
      store.run(
        `INSERT INTO provider_facts(provider_fact_id, binding_id, provider_id, dedup_key, fact_type, fact_json, observed_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        fact.providerFactId, fact.bindingId, fact.provider, dedupKey, fact.kind, encodeJson(fact), fact.observedAt, receivedAt,
      );
      return true;
    },
    listFacts(bindingIds) {
      if (bindingIds.length === 0) return [];
      const placeholders = bindingIds.map(() => "?").join(",");
      return store.many<Row>(
        `SELECT fact_json FROM provider_facts WHERE binding_id IN (${placeholders}) ORDER BY observed_at, provider_fact_id`,
        ...bindingIds,
      ).map((row) => decodeJson<ProviderFact>(row.fact_json));
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

  const artifact: ArtifactStore = {
    recordArtifact(value) {
      const existingById = store.one<Row>("SELECT * FROM artifacts WHERE artifact_id = ?", value.artifactId);
      if (existingById) {
        const existing = toArtifact(existingById);
        if (!sameArtifact(existing, value)) throw new Error("artifact_idempotency_conflict");
        return existing;
      }
      if (value.sourceMessageId) {
        const existingByClaim = store.one<Row>(
          "SELECT * FROM artifacts WHERE source_message_id = ? AND workspace_relative_path = ?",
          value.sourceMessageId,
          value.workspaceRelativePath,
        );
        if (existingByClaim) {
          const existing = toArtifact(existingByClaim);
          if (!sameArtifact(existing, value)) throw new Error("artifact_claim_conflict");
          return existing;
        }
      }
      store.run(
        `INSERT INTO artifacts(artifact_id, task_id, run_id, workspace_relative_path, content_digest, source_invocation_id, source_provider_fact_id, source_message_id, evidence_reference_ids_json, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        value.artifactId, value.taskId, value.runId, value.workspaceRelativePath, value.contentDigest,
        value.sourceInvocationId ?? null, value.sourceProviderFactId ?? null, value.sourceMessageId ?? null,
        encodeJson(value.evidenceReferenceIds), value.verifiedAt,
      );
      return toArtifact(store.one<Row>("SELECT * FROM artifacts WHERE artifact_id = ?", value.artifactId)!);
    },
    listArtifacts(runId) {
      return store.many<Row>("SELECT * FROM artifacts WHERE run_id = ? ORDER BY verified_at", runId).map(toArtifact);
    },
    listArtifactsForTask(taskId) {
      return store.many<Row>("SELECT * FROM artifacts WHERE task_id = ? ORDER BY verified_at, artifact_id", taskId).map(toArtifact);
    },
    getArtifact(artifactId) {
      const row = store.one<Row>("SELECT * FROM artifacts WHERE artifact_id = ?", artifactId);
      return row ? toArtifact(row) : undefined;
    },
    findArtifactByClaim(sourceMessageId, workspaceRelativePath) {
      const row = store.one<Row>(
        "SELECT * FROM artifacts WHERE source_message_id = ? AND workspace_relative_path = ?",
        sourceMessageId,
        workspaceRelativePath,
      );
      return row ? toArtifact(row) : undefined;
    },
  };

  const retention: TaskRetentionStore = {
    getPermanentDeleteIntent(commandId) {
      const row = store.one<Row>("SELECT * FROM task_permanent_delete_intents WHERE command_id = ?", commandId);
      return row ? toTaskPermanentDeleteIntent(row) : undefined;
    },
    getPermanentDeleteIntentForTask(taskId) {
      const row = store.one<Row>("SELECT * FROM task_permanent_delete_intents WHERE task_id = ?", taskId);
      return row ? toTaskPermanentDeleteIntent(row) : undefined;
    },
    getPermanentDeleteTombstone(commandId) {
      const row = store.one<Row>("SELECT * FROM task_permanent_delete_tombstones WHERE command_id = ?", commandId);
      return row ? toTaskPermanentDeleteTombstone(row) : undefined;
    },
    preparePermanentDelete(intent) {
      return store.transaction(() => {
        const existingByCommand = store.one<Row>("SELECT * FROM task_permanent_delete_intents WHERE command_id = ?", intent.commandId);
        if (existingByCommand) {
          const existing = toTaskPermanentDeleteIntent(existingByCommand);
          assertSamePermanentDeleteIntent(existing, intent);
          return existing;
        }
        const existingByTask = store.one<Row>("SELECT command_id FROM task_permanent_delete_intents WHERE task_id = ?", intent.taskId);
        if (existingByTask) throw new Error("task_permanent_delete_in_progress");
        const task = store.one<Row>("SELECT revision, trashed_at FROM tasks WHERE task_id = ?", intent.taskId);
        if (!task) throw new Error("task_not_found");
        if (number(task.revision) !== intent.expectedRevision) throw new Error("stale_task_revision");
        if (!optionalText(task.trashed_at)) throw new Error("task_not_in_recycle_bin");
        if (new Set(intent.artifactIds).size !== intent.artifactIds.length) throw new Error("task_permanent_delete_artifact_ids_duplicate");
        for (const artifactId of intent.artifactIds) {
          const artifact = store.one<Row>("SELECT task_id FROM artifacts WHERE artifact_id = ?", artifactId);
          if (!artifact || text(artifact.task_id) !== intent.taskId) throw new Error("task_permanent_delete_artifact_not_registered");
        }
        store.run(
          `INSERT INTO task_permanent_delete_intents(command_id, task_id, expected_revision, artifact_ids_json, payload_fingerprint, prepared_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          intent.commandId,
          intent.taskId,
          intent.expectedRevision,
          encodeJson(intent.artifactIds),
          intent.payloadFingerprint,
          intent.preparedAt,
        );
        return intent;
      });
    },
    completePermanentDelete(input) {
      return store.transaction(() => {
        const existing = store.one<Row>("SELECT * FROM task_permanent_delete_tombstones WHERE command_id = ?", input.commandId);
        if (existing) {
          const tombstone = toTaskPermanentDeleteTombstone(existing);
          if (tombstone.taskId !== input.taskId || tombstone.payloadFingerprint !== input.payloadFingerprint) {
            throw new Error("runtime_command_id_reused_with_different_payload");
          }
          return tombstone;
        }
        const intentRow = store.one<Row>("SELECT * FROM task_permanent_delete_intents WHERE command_id = ?", input.commandId);
        if (!intentRow) throw new Error("task_permanent_delete_intent_not_found");
        const intent = toTaskPermanentDeleteIntent(intentRow);
        if (intent.taskId !== input.taskId || intent.payloadFingerprint !== input.payloadFingerprint) {
          throw new Error("runtime_command_id_reused_with_different_payload");
        }
        if (input.result.taskId !== input.taskId) throw new Error("task_permanent_delete_result_task_mismatch");
        deleteTaskGraph(store, input.taskId);
        const tombstone: TaskPermanentDeleteTombstone = {
          commandId: input.commandId,
          taskId: input.taskId,
          payloadFingerprint: input.payloadFingerprint,
          result: input.result,
          deletedAt: input.result.deletedAt,
        };
        store.run(
          `INSERT INTO task_permanent_delete_tombstones(command_id, task_id, payload_fingerprint, result_json, deleted_at)
           VALUES (?, ?, ?, ?, ?)`,
          tombstone.commandId,
          tombstone.taskId,
          tombstone.payloadFingerprint,
          encodeJson(tombstone.result),
          tombstone.deletedAt,
        );
        return tombstone;
      });
    },
  };

  const presentation: PresentationStore = {
    savePresentation(value) {
      store.run(
        `INSERT INTO presentation_leases(presentation_lease_id, binding_id, descriptor_json, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(presentation_lease_id) DO UPDATE SET descriptor_json = excluded.descriptor_json, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at`,
        value.presentationLeaseId, value.bindingId, encodeJson(value), value.expiresAt, value.revokedAt ?? null, store.now(),
      );
    },
    getPresentation(presentationLeaseId) {
      const row = store.one<Row>("SELECT descriptor_json FROM presentation_leases WHERE presentation_lease_id = ?", presentationLeaseId);
      return row ? decodeJson<SessionPresentation>(row.descriptor_json) : undefined;
    },
    revokePresentation(presentationLeaseId, revokedAt) {
      const current = this.getPresentation(presentationLeaseId);
      if (!current) throw new Error("presentation_lease_not_found");
      if (current.revokedAt) return current;
      const revoked: SessionPresentation = { ...current, revokedAt };
      store.run(
        "UPDATE presentation_leases SET descriptor_json = ?, revoked_at = ? WHERE presentation_lease_id = ?",
        encodeJson(revoked),
        revokedAt,
        presentationLeaseId,
      );
      return revoked;
    },
    listPresentations(bindingIds, now) {
      if (bindingIds.length === 0) return [];
      const placeholders = bindingIds.map(() => "?").join(",");
      return store.many<Row>(`SELECT descriptor_json FROM presentation_leases WHERE binding_id IN (${placeholders}) AND expires_at > ? AND revoked_at IS NULL`, ...bindingIds, now)
        .map((row) => decodeJson<SessionPresentation>(row.descriptor_json));
    },
  };

  const read: RuntimeReadStore = {
    readModel(now, request = {}) {
      const { taskId, templateId } = request;
      const workspaceLibrary = {
        authorizations: workspace.listAuthorizations().map(({ workspaceId, displayName, authorizedAt }) => ({
          workspaceId,
          displayName,
          authorizedAt,
        })),
      };
      const templateLibrary = { templates: templateTask.listTemplateLibrary(), drafts: templateTask.listDrafts() };
      const taskLibrary = { tasks: templateTask.listTasks() };
      const selectedTemplate = templateId ? templateTask.getTemplate(templateId) : undefined;
      const template: TemplateSelectionReadModel | undefined = selectedTemplate ? {
        template: selectedTemplate,
        // Version history is deliberately a focused read.  It does not expose
        // mutable Draft content, asset bytes, native Provider data, or cwd.
        versions: templateTask.listTemplateVersions(selectedTemplate.templateId).map(toTemplateVersionReadModel),
      } : undefined;
      const base = {
        generatedAt: now,
        configuration: {
          metaProfileOptions: [],
          executionProfileReadiness: [],
          taskSetupDrafts: configuration.listTaskSetupDrafts(),
          metaSessions: configuration.listMetaSessions(),
          metaMessages: configuration.listMetaMessages(),
          metaPatchProposals: configuration.listMetaPatchProposals(),
          metaTurns: configuration.listMetaTurns().map(toMetaTurnReadModel),
        },
        workspaceLibrary,
        templateLibrary,
        ...(template ? { template } : {}),
        taskLibrary,
      };
      if (!taskId) return base;
      const task = templateTask.getTask(taskId);
      if (!task) return base;
      // Artifact references contain a Host-private relative path. Read models
      // retain only managed identity and basename, while Timeline derivation
      // receives the private records inside this Store boundary.
      const artifacts = artifact.listArtifactsForTask(task.taskId);
      const managedArtifacts = artifacts.map(toManagedArtifactReadModel);
      const activeRun = task.activeRunId ? templateTask.getRun(task.activeRunId) : undefined;
      if (!activeRun) {
        const logicalSessions: readonly LogicalSessionRecord[] = [];
        const bindings: readonly ProviderSessionBindingRecord[] = [];
        const inputs: readonly InputSubmissionRecord[] = [];
        const invocations: readonly InvocationRecord[] = [];
        const sessionTurns: readonly SessionTurnRecord[] = [];
        const messages: readonly SessionMessageRecord[] = [];
        const relayBlocks: readonly RelayBlockRecord[] = [];
        const messageForwards: readonly MessageForwardRecord[] = [];
        const messageForwardBatches: readonly MessageForwardBatchRecord[] = [];
        const humanInterventions: readonly HumanInterventionRecord[] = [];
        const inboxItems: readonly SessionInboxItemRecord[] = [];
        const attentions: readonly AttentionRecord[] = [];
        return {
          ...base,
          task: {
            task,
            logicalSessions,
            bindings,
            inputs,
            invocations,
            sessionTurns,
            messages,
            relayBlocks,
            messageForwards,
            messageForwardBatches,
            humanInterventions,
            inboxItems,
            attentions,
            providerActivities: [],
            artifacts: managedArtifacts,
            presentations: [],
            timeline: deriveTaskTimeline({
              task,
              bindings,
              inputs,
              invocations,
              sessionTurns,
              messages,
              relayBlocks,
              messageForwards,
              humanInterventions,
              inboxItems,
              attentions,
              artifacts,
              providerFacts: [],
            }),
          },
        };
      }
      const logicalSessions = binding.listLogicalSessions(activeRun.runId);
      const bindings = binding.listBindings(activeRun.runId);
      const inputs = invocation.listInputs(activeRun.runId);
      const invocations = invocation.listInvocations(activeRun.runId);
      const sessionTurns = turn.listTurns(activeRun.runId);
      const messages = message.listMessages(activeRun.runId);
      const relayBlocks = message.listRelayBlocks(activeRun.runId);
      const messageForwards = forward.listForwards(activeRun.runId);
      const messageForwardBatches = forward.listBatches(activeRun.runId);
      const humanInterventions = humanIntervention.listInterventions(activeRun.runId);
      const inboxItems = inbox.listInboxItems(activeRun.runId);
      const attentions = invocation.listAttentions(activeRun.runId);
      const providerFacts = providerFact.listFacts(bindings.map((item) => item.bindingId));
      const providerActivities = deriveProviderActivities({ bindings, sessionTurns, providerFacts });
      return {
        ...base,
        task: {
          task,
          activeRun,
          logicalSessions,
          bindings,
          inputs,
          invocations,
          sessionTurns,
          messages,
          relayBlocks,
          messageForwards,
          messageForwardBatches,
          humanInterventions,
          inboxItems,
          attentions,
          providerActivities,
          artifacts: managedArtifacts,
          presentations: presentation.listPresentations(bindings.map((item) => item.bindingId), now),
          timeline: deriveTaskTimeline({
            task,
            activeRun,
            bindings,
            inputs,
            invocations,
            sessionTurns,
            messages,
            relayBlocks,
            messageForwards,
            humanInterventions,
            inboxItems,
            attentions,
            artifacts,
            providerFacts,
          }),
        },
      };
    },
  };

  return {
    transaction: (work) => store.transaction(work),
    templateTask,
    binding,
    message,
    forward,
    humanIntervention,
    inbox,
    turn,
    invocation,
    providerFact,
    command,
    artifact,
    retention,
    presentation,
    workspace,
    configuration,
    read,
  };
}

function toTemplateVersionReadModel(version: TemplateVersionRecord): TemplateVersionReadModel {
  return {
    templateVersionId: version.templateVersionId,
    templateId: version.templateId,
    version: version.version,
    definition: version.definition,
    definitionHash: version.definitionHash,
    ...(version.assetManifestHash ? { assetManifestHash: version.assetManifestHash } : {}),
    createdAt: version.createdAt,
    publishedAt: version.publishedAt,
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
  return compact({
    metaTurnId: text(row.meta_turn_id),
    metaSessionId: text(row.meta_session_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    userMetaMessageId: text(row.user_meta_message_id),
    assistantMetaMessageId: text(row.assistant_meta_message_id),
    metaPatchProposalId: text(row.meta_patch_proposal_id),
    profile: decodeJson<MetaProfileDefinition>(row.profile_json),
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

function assertNewMetaTurnInput(input: CreateMetaTurnStorageInput): void {
  const { session, expectedSessionRevision, userMessage, turn } = input;
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

function insertSession(store: SqliteRuntimeStore, session: LogicalSessionRecord): void {
  store.run(
    `INSERT INTO logical_sessions(logical_session_id, task_id, run_id, agent_card_id, kind, execution_profile_id, status, ordinal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    session.logicalSessionId, session.taskId, session.runId, session.agentCardId, session.kind, session.executionProfileId,
    session.status, session.ordinal, session.createdAt, session.updatedAt,
  );
}

function insertBinding(store: SqliteRuntimeStore, binding: ProviderSessionBindingRecord): void {
  store.run(
    `INSERT INTO provider_session_bindings(binding_id, task_id, run_id, logical_session_id, execution_profile_id, provider_id, provider_host_id, native_binding_ref, binding_revision, status, recoverable, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    binding.bindingId, binding.taskId, binding.runId, binding.logicalSessionId, binding.executionProfileId, binding.provider,
    binding.providerHostId ?? null, binding.nativeBindingRef ?? null, binding.bindingRevision, binding.status,
    binding.recoverable ? 1 : 0, binding.createdAt, binding.updatedAt,
  );
}

function insertOutbox(store: SqliteRuntimeStore, outbox: OutboxRecord): void {
  store.run(
    `INSERT INTO outbox(outbox_id, command_id, provider_id, kind, binding_id, payload_json, state, attempts, lease_until, last_effect_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    outbox.outboxId, outbox.commandId, outbox.provider, outbox.kind, outbox.bindingId ?? null, encodeJson(outbox.payload),
    outbox.state, outbox.attempts, outbox.leaseUntil ?? null, outbox.lastEffect ? encodeJson(outbox.lastEffect) : null,
    outbox.createdAt, outbox.updatedAt,
  );
}

function toTemplate(row: Row): TemplateRecord {
  return compact({
    templateId: text(row.template_id), slug: text(row.slug), title: text(row.title),
    description: optionalText(row.description), activeVersionId: optionalText(row.active_version_id), archivedAt: optionalText(row.archived_at),
    revision: number(row.revision), createdAt: text(row.created_at), updatedAt: text(row.updated_at),
  });
}

function toTemplateVersion(row: Row): TemplateVersionRecord {
  return {
    templateVersionId: text(row.template_version_id),
    templateId: text(row.template_id),
    version: number(row.version),
    definition: decodeJson<TemplateDefinition>(row.definition_json),
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
    metadata: decodeJson<TemplateDraftRecord["metadata"]>(row.metadata_json), definition: decodeJson<TemplateDefinition>(row.definition_json), status: text(row.status) as TemplateDraftRecord["status"], ownerId: text(row.owner_id),
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
  const targetKind = text(row.target_kind);
  const mode = text(row.mode);
  const base = {
    metaSessionId: text(row.meta_session_id),
    ownerId: text(row.owner_id),
    metaProfileOptionId: text(row.meta_profile_option_id),
    metaProfile: decodeJson<MetaSessionRecord["metaProfile"]>(row.meta_profile_json),
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
    sourceMetaProfile: decodeJson<MetaPatchProposalRecord["sourceMetaProfile"]>(row.source_meta_profile_json),
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
  return {
    architectureSnapshotId: text(row.architecture_snapshot_id), taskId: text(row.task_id), templateId: text(row.template_id),
    templateVersionId: text(row.template_version_id), templateDefinitionHash: text(row.template_definition_hash),
    definition: decodeJson<TemplateDefinition>(row.definition_json),
    taskInputValues: decodeJson<TaskArchitectureSnapshot["taskInputValues"]>(row.task_input_values_json),
    taskGoalContent: text(row.task_goal_content),
    taskGoalContentDigest: text(row.task_goal_content_digest),
    taskGoalCompilerVersion: text(row.task_goal_compiler_version) as TaskArchitectureSnapshot["taskGoalCompilerVersion"],
    workspace: decodeJson<TaskArchitectureSnapshot["workspace"]>(row.workspace_json),
    createdAt: text(row.created_at),
  };
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

function toLogicalSession(row: Row): LogicalSessionRecord {
  return { logicalSessionId: text(row.logical_session_id), taskId: text(row.task_id), runId: text(row.run_id), kind: text(row.kind) as LogicalSessionRecord["kind"], agentCardId: text(row.agent_card_id), executionProfileId: text(row.execution_profile_id), status: text(row.status) as LogicalSessionRecord["status"], ordinal: number(row.ordinal), createdAt: text(row.created_at), updatedAt: text(row.updated_at) };
}

function toBinding(row: Row): ProviderSessionBindingRecord {
  return compact({ bindingId: text(row.binding_id), taskId: text(row.task_id), runId: text(row.run_id), logicalSessionId: text(row.logical_session_id), executionProfileId: text(row.execution_profile_id), provider: text(row.provider_id) as ProviderSessionBindingRecord["provider"], providerHostId: optionalText(row.provider_host_id), nativeBindingRef: optionalText(row.native_binding_ref), bindingRevision: number(row.binding_revision), status: text(row.status) as ProviderSessionBindingRecord["status"], recoverable: number(row.recoverable) === 1, createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
}

function toInput(row: Row): InputSubmissionRecord {
  return compact({ inputSubmissionId: text(row.input_submission_id), sourceInboxItemId: text(row.source_inbox_item_id), taskId: text(row.task_id), runId: text(row.run_id), logicalSessionId: text(row.logical_session_id), bindingId: text(row.binding_id), contentMessageId: text(row.content_message_id), deliveryRole: text(row.delivery_role) as InputSubmissionRecord["deliveryRole"], content: text(row.content), contentDigest: text(row.content_digest), sequenceNumber: number(row.sequence_number), idempotencyKey: text(row.idempotency_key), status: text(row.status) as InputSubmissionRecord["status"], providerEffectId: optionalText(row.provider_effect_id), nativeMessageId: optionalText(row.native_message_id), nativeTurnId: optionalText(row.native_turn_id), evidenceReferenceId: optionalText(row.evidence_reference_id), supersedesInputSubmissionId: optionalText(row.supersedes_input_submission_id), createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
}

function toInvocation(row: Row): InvocationRecord {
  return compact({ invocationId: text(row.invocation_id), taskId: text(row.task_id), runId: text(row.run_id), replyToLogicalSessionId: text(row.reply_to_logical_session_id), targetLogicalSessionId: text(row.target_logical_session_id), targetAgentCardId: text(row.target_agent_card_id), bindingId: text(row.binding_id), assignmentMessageId: text(row.assignment_message_id), instruction: text(row.instruction), acceptanceCriteria: decodeJson<readonly string[]>(row.acceptance_criteria_json), requestedArtifacts: decodeJson<readonly string[]>(row.requested_artifacts_json), priority: optionalText(row.priority) as InvocationRecord["priority"], finalMessageId: optionalText(row.final_message_id), status: text(row.status) as InvocationRecord["status"], createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
}

function toSessionMessage(row: Row): SessionMessageRecord {
  return compact({
    messageId: text(row.message_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    sourceLogicalSessionId: optionalText(row.source_logical_session_id),
    sourceSessionTurnId: optionalText(row.source_session_turn_id),
    sourceHumanInterventionId: optionalText(row.source_human_intervention_id),
    invocationId: optionalText(row.invocation_id),
    kind: text(row.kind) as SessionMessageRecord["kind"],
    content: text(row.content),
    contentDigest: text(row.content_digest),
    taskGoalCompilerVersion: optionalText(row.task_goal_compiler_version) as SessionMessageRecord["taskGoalCompilerVersion"],
    createdAt: text(row.created_at),
  });
}

function toRelayBlock(row: Row): RelayBlockRecord {
  return compact({
    relayBlockId: text(row.relay_block_id),
    sourceMessageId: text(row.source_message_id),
    ordinal: number(row.ordinal),
    suggestedTargetAgentCardIds: decodeJson<readonly string[]>(row.suggested_target_agent_card_ids_json),
    suggestedAudience: optionalText(row.suggested_audience) as RelayBlockRecord["suggestedAudience"],
    topic: optionalText(row.topic),
    format: text(row.format) as RelayBlockRecord["format"],
    content: text(row.content),
    contentDigest: text(row.content_digest),
    parserVersion: number(row.parser_version),
    sourceRange: { start: number(row.source_start), end: number(row.source_end) },
    createdAt: text(row.created_at),
  });
}

function toSessionInboxItem(row: Row): SessionInboxItemRecord {
  return compact({
    inboxItemId: text(row.inbox_item_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    targetLogicalSessionId: text(row.target_logical_session_id),
    renderedMessageId: text(row.rendered_message_id),
    forwardId: optionalText(row.forward_id),
    humanInterventionId: optionalText(row.human_intervention_id),
    replyToLogicalSessionId: optionalText(row.reply_to_logical_session_id),
    state: text(row.state) as SessionInboxItemRecord["state"],
    leaseId: optionalText(row.lease_id),
    leaseExpiresAt: optionalText(row.lease_expires_at),
    deliveryInputSubmissionId: optionalText(row.delivery_input_submission_id),
    revision: number(row.revision),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function listForwardSelections(store: SqliteRuntimeStore, forwardId: string): MessageForwardRecord["selections"] {
  return store.many<Row>("SELECT * FROM message_forward_selections WHERE forward_id = ? ORDER BY ordinal", forwardId)
    .map((row) => compact({
      forwardSelectionId: text(row.forward_selection_id),
      forwardId: text(row.forward_id),
      ordinal: number(row.ordinal),
      kind: text(row.kind) as MessageForwardRecord["selections"][number]["kind"],
      sourceMessageId: text(row.source_message_id),
      relayBlockId: optionalText(row.relay_block_id),
      contentDigest: text(row.content_digest),
    }));
}

function toMessageForward(row: Row, selections: MessageForwardRecord["selections"]): MessageForwardRecord {
  return compact({
    forwardId: text(row.forward_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    expectedTaskRevision: number(row.expected_task_revision),
    publishBatchId: optionalText(row.publish_batch_id),
    targetIdempotencyKey: text(row.target_idempotency_key),
    decidedByLogicalSessionId: text(row.decided_by_logical_session_id),
    decidedBySessionTurnId: text(row.decided_by_session_turn_id),
    targetLogicalSessionId: text(row.target_logical_session_id),
    mode: text(row.mode) as MessageForwardRecord["mode"],
    selections,
    renderedMessageId: text(row.rendered_message_id),
    createdAt: text(row.created_at),
  });
}

function toMessageForwardBatch(row: Row): MessageForwardBatchRecord {
  return {
    publishBatchId: text(row.publish_batch_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    expectedTaskRevision: number(row.expected_task_revision),
    fanoutKey: text(row.fanout_key),
    decidedByLogicalSessionId: text(row.decided_by_logical_session_id),
    decidedBySessionTurnId: text(row.decided_by_session_turn_id),
    targetLogicalSessionIds: decodeJson<readonly string[]>(row.target_logical_session_ids_json),
    selectionDigest: text(row.selection_digest),
    state: text(row.state) as MessageForwardBatchRecord["state"],
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function toHumanIntervention(row: Row): HumanInterventionRecord {
  return compact({
    humanInterventionId: text(row.human_intervention_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    commandId: text(row.command_id),
    idempotencyKey: text(row.idempotency_key),
    expectedTaskRevision: number(row.expected_task_revision),
    targetLogicalSessionId: text(row.target_logical_session_id),
    content: text(row.content),
    contentDigest: text(row.content_digest),
    affectedSessionTurnId: optionalText(row.affected_session_turn_id),
    affectedInvocationId: optionalText(row.affected_invocation_id),
    mode: text(row.mode) as HumanInterventionRecord["mode"],
    cardMessageId: optionalText(row.card_message_id),
    conductorMirrorMessageId: optionalText(row.conductor_mirror_message_id),
    state: text(row.state) as HumanInterventionRecord["state"],
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toSessionTurn(row: Row): SessionTurnRecord {
  return compact({
    sessionTurnId: text(row.session_turn_id),
    taskId: text(row.task_id),
    runId: text(row.run_id),
    inputSubmissionId: text(row.input_submission_id),
    targetLogicalSessionId: text(row.target_logical_session_id),
    kind: text(row.kind) as SessionTurnRecord["kind"],
    initiator: text(row.initiator) as SessionTurnRecord["initiator"],
    trigger: text(row.trigger) as SessionTurnRecord["trigger"],
    replyToLogicalSessionId: optionalText(row.reply_to_logical_session_id),
    invocationId: optionalText(row.invocation_id),
    humanInterventionId: optionalText(row.human_intervention_id),
    affectedSessionTurnId: optionalText(row.affected_session_turn_id),
    finalMessageId: optionalText(row.final_message_id),
    status: text(row.status) as SessionTurnRecord["status"],
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  });
}

function toAttention(row: Row): AttentionRecord {
  return compact({ attentionId: text(row.attention_id), taskId: text(row.task_id), runId: text(row.run_id), bindingId: text(row.binding_id), bindingRevision: number(row.binding_revision), nativeRequestId: text(row.native_request_id), activeInputSubmissionId: optionalText(row.active_input_submission_id), activeInvocationId: optionalText(row.active_invocation_id), request: decodeJson<JsonObject>(row.request_json), response: row.response_json ? decodeJson<JsonObject>(row.response_json) : undefined, status: text(row.status) as AttentionRecord["status"], createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
}

function toArtifact(row: Row): ArtifactReference {
  return compact({ artifactId: text(row.artifact_id), taskId: text(row.task_id), runId: text(row.run_id), workspaceRelativePath: text(row.workspace_relative_path), contentDigest: text(row.content_digest), sourceInvocationId: optionalText(row.source_invocation_id), sourceProviderFactId: optionalText(row.source_provider_fact_id), sourceMessageId: optionalText(row.source_message_id), evidenceReferenceIds: decodeJson<readonly string[]>(row.evidence_reference_ids_json), verifiedAt: text(row.verified_at) });
}

function sameArtifact(left: ArtifactReference, right: ArtifactReference): boolean {
  return left.artifactId === right.artifactId
    && left.taskId === right.taskId
    && left.runId === right.runId
    && left.workspaceRelativePath === right.workspaceRelativePath
    && left.contentDigest === right.contentDigest
    && left.sourceInvocationId === right.sourceInvocationId
    && left.sourceProviderFactId === right.sourceProviderFactId
    && left.sourceMessageId === right.sourceMessageId
    && JSON.stringify(left.evidenceReferenceIds) === JSON.stringify(right.evidenceReferenceIds);
}

function toManagedArtifactReadModel(artifact: ArtifactReference): ManagedArtifactReadModel {
  return {
    artifactId: artifact.artifactId,
    taskId: artifact.taskId,
    runId: artifact.runId,
    displayName: artifactDisplayName(artifact.workspaceRelativePath),
    contentDigest: artifact.contentDigest,
    ...(artifact.sourceInvocationId ? { sourceInvocationId: artifact.sourceInvocationId } : {}),
    verifiedAt: artifact.verifiedAt,
  };
}

function toTaskPermanentDeleteIntent(row: Row): TaskPermanentDeleteIntent {
  return {
    commandId: text(row.command_id),
    taskId: text(row.task_id),
    expectedRevision: number(row.expected_revision),
    artifactIds: decodeJson<readonly string[]>(row.artifact_ids_json),
    payloadFingerprint: text(row.payload_fingerprint),
    preparedAt: text(row.prepared_at),
  };
}

function toTaskPermanentDeleteTombstone(row: Row): TaskPermanentDeleteTombstone {
  return {
    commandId: text(row.command_id),
    taskId: text(row.task_id),
    payloadFingerprint: text(row.payload_fingerprint),
    result: decodeJson<TaskPermanentDeleteResult>(row.result_json),
    deletedAt: text(row.deleted_at),
  };
}

function assertSamePermanentDeleteIntent(left: TaskPermanentDeleteIntent, right: TaskPermanentDeleteIntent): void {
  if (
    left.taskId !== right.taskId
    || left.expectedRevision !== right.expectedRevision
    || left.payloadFingerprint !== right.payloadFingerprint
    || left.artifactIds.length !== right.artifactIds.length
    || left.artifactIds.some((artifactId, index) => artifactId !== right.artifactIds[index])
  ) {
    throw new Error("runtime_command_id_reused_with_different_payload");
  }
}

/** Deletes only rows owned by one Task, in FK dependency order. */
function deleteTaskGraph(store: SqliteRuntimeStore, taskId: string): void {
  const bindingSelector = "SELECT binding_id FROM provider_session_bindings WHERE task_id = ?";
  store.run(`DELETE FROM presentation_leases WHERE binding_id IN (${bindingSelector})`, taskId);
  store.run(`DELETE FROM outbox WHERE binding_id IN (${bindingSelector})`, taskId);
  store.run(`DELETE FROM provider_facts WHERE binding_id IN (${bindingSelector})`, taskId);
  store.run(`DELETE FROM async_operations WHERE binding_id IN (${bindingSelector})`, taskId);
  store.run("DELETE FROM attentions WHERE task_id = ?", taskId);
  store.run("DELETE FROM artifacts WHERE task_id = ?", taskId);
  store.run("UPDATE session_inbox_items SET delivery_input_submission_id = NULL WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_turns WHERE task_id = ?", taskId);
  store.run("DELETE FROM input_submissions WHERE task_id = ?", taskId);
  store.run("DELETE FROM session_inbox_items WHERE task_id = ?", taskId);
  store.run("DELETE FROM human_interventions WHERE task_id = ?", taskId);
  store.run("DELETE FROM message_forward_selections WHERE forward_id IN (SELECT forward_id FROM message_forwards WHERE task_id = ?)", taskId);
  store.run("DELETE FROM message_forwards WHERE task_id = ?", taskId);
  store.run("DELETE FROM message_forward_batches WHERE task_id = ?", taskId);
  store.run("UPDATE session_messages SET invocation_id = NULL WHERE task_id = ?", taskId);
  store.run("DELETE FROM invocations WHERE task_id = ?", taskId);
  store.run(
    "DELETE FROM relay_blocks WHERE source_message_id IN (SELECT message_id FROM session_messages WHERE task_id = ?)",
    taskId,
  );
  store.run("DELETE FROM session_messages WHERE task_id = ?", taskId);
  store.run("DELETE FROM provider_session_bindings WHERE task_id = ?", taskId);
  store.run("DELETE FROM logical_sessions WHERE task_id = ?", taskId);
  store.run("DELETE FROM task_runs WHERE task_id = ?", taskId);
  // The pending-intent FK must be removed before its Task owner, whereas the
  // tombstone is intentionally inserted after deletion and has no Task FK.
  store.run("DELETE FROM task_permanent_delete_intents WHERE task_id = ?", taskId);
  // Configuration audit survives Task retention deletion, but cannot retain a
  // live foreign key to the intentionally removed Task row.
  store.run("UPDATE task_setup_drafts SET created_task_id = NULL WHERE created_task_id = ?", taskId);
  store.run("DELETE FROM tasks WHERE task_id = ?", taskId);
  store.run("DELETE FROM task_architecture_snapshots WHERE task_id = ?", taskId);
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

function toOutbox(row: Row): OutboxRecord {
  return compact({ outboxId: text(row.outbox_id), commandId: text(row.command_id), provider: text(row.provider_id), kind: text(row.kind) as OutboxRecord["kind"], bindingId: optionalText(row.binding_id), payload: decodeJson<JsonObject>(row.payload_json), state: text(row.state) as OutboxRecord["state"], attempts: number(row.attempts), leaseUntil: optionalText(row.lease_until), lastEffect: row.last_effect_json ? decodeJson<JsonObject>(row.last_effect_json) : undefined, createdAt: text(row.created_at), updatedAt: text(row.updated_at) });
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
