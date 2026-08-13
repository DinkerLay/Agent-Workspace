import { constants as sqliteConstants, DatabaseSync, type SQLInputValue } from "node:sqlite";
import { EMPTY_TEMPLATE_ASSET_MANIFEST_HASH, hashDefinition } from "@agent-workspace/runtime-contracts";

export const SUPERSEDED_PROTOCOL_META_KEY = "superseded_protocol_tables";

export const SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST = Object.freeze([
  "logical_sessions",
  "provider_session_bindings",
  "provider_facts",
  "async_operations",
  "attentions",
  "outbox",
  "artifacts",
  "task_permanent_delete_intents",
  "task_permanent_delete_tombstones",
  "presentation_leases",
  "runtime_events",
  "provider_hosts",
  "evidence_references",
  "session_messages",
  "relay_blocks",
  "input_submissions",
  "session_inbox_items",
  "message_forward_batches",
  "message_forwards",
  "message_forward_selections",
  "human_interventions",
  "session_turns",
  "invocations",
  "invocation_results",
  "wakeups",
] as const);

const RETAINED_DIRECT_PROTOCOL_TABLES = Object.freeze([
  "session_id_provider_bindings",
  "session_id_provider_facts",
  "session_id_attentions",
  "session_id_provider_effect_outbox",
] as const);

const RETAINED_DIRECT_MIGRATION_DENIED_ACTIONS = new Set<number>([
  sqliteConstants.SQLITE_READ,
  sqliteConstants.SQLITE_INSERT,
  sqliteConstants.SQLITE_UPDATE,
  sqliteConstants.SQLITE_DELETE,
  sqliteConstants.SQLITE_CREATE_INDEX,
  sqliteConstants.SQLITE_DROP_INDEX,
  sqliteConstants.SQLITE_CREATE_TRIGGER,
  sqliteConstants.SQLITE_DROP_TRIGGER,
  sqliteConstants.SQLITE_DROP_TABLE,
  sqliteConstants.SQLITE_ALTER_TABLE,
  sqliteConstants.SQLITE_REINDEX,
]);

export type SqliteRuntimeStoreOptions = {
  path: string;
  now?: () => string;
  /** Deterministic migration crash seam used by focused durability tests. */
  migrationFailpoint?: (stage: "after_acp_v3_tables") => void;
};

/**
 * The Runtime Host owns this connection. Repositories receive this narrow store
 * capability instead of a raw DatabaseSync instance.
 */
export class SqliteRuntimeStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;
  readonly #migrationFailpoint?: SqliteRuntimeStoreOptions["migrationFailpoint"];
  readonly #retainedDirectProtocolTables: ReadonlySet<string>;
  #migrationInProgress = true;
  #transactionDepth = 0;

  constructor({ path, now = () => new Date().toISOString(), migrationFailpoint }: SqliteRuntimeStoreOptions) {
    this.#database = new DatabaseSync(path);
    this.#now = now;
    this.#migrationFailpoint = migrationFailpoint;
    this.#retainedDirectProtocolTables = new Set(this.#findRetainedDirectProtocolTables());
    try {
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      const supersededProtocolTables = this.#findSupersededProtocolTables();
      this.#installSupersededProtocolAuthorizer();
      this.#migrate();
      this.#migrationInProgress = false;
      this.#recordSupersededProtocolTables(supersededProtocolTables);
    } catch (error) {
      this.#migrationInProgress = false;
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  now(): string {
    return this.#now();
  }

  transaction<T>(work: () => T): T {
    if (this.#transactionDepth > 0) {
      const savepoint = `runtime_nested_${this.#transactionDepth}`;
      this.#database.exec(`SAVEPOINT ${savepoint}`);
      this.#transactionDepth += 1;
      try {
        const result = work();
        this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.#database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        this.#transactionDepth -= 1;
      }
    }
    this.#database.exec("BEGIN IMMEDIATE");
    this.#transactionDepth = 1;
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth = 0;
    }
  }

  run(sql: string, ...parameters: SQLInputValue[]): void {
    this.#database.prepare(sql).run(...parameters);
  }

  one<T extends Record<string, unknown>>(sql: string, ...parameters: SQLInputValue[]): T | undefined {
    return this.#database.prepare(sql).get(...parameters) as T | undefined;
  }

  many<T extends Record<string, unknown>>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.#database.prepare(sql).all(...parameters) as T[];
  }

  #installSupersededProtocolAuthorizer(): void {
    const superseded = new Set<string>(SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST);
    this.#database.setAuthorizer((actionCode, argument1, argument2) => {
      const touchesSuperseded = (argument1 !== null && superseded.has(argument1))
        || (argument2 !== null && superseded.has(argument2));
      const touchesRetainedDirect = this.#migrationInProgress
        && RETAINED_DIRECT_MIGRATION_DENIED_ACTIONS.has(actionCode)
        && ((argument1 !== null && this.#retainedDirectProtocolTables.has(argument1))
          || (argument2 !== null && this.#retainedDirectProtocolTables.has(argument2)));
      return touchesSuperseded || touchesRetainedDirect
        ? sqliteConstants.SQLITE_DENY
        : sqliteConstants.SQLITE_OK;
    });
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS templates (
        template_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        active_version_id TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS template_versions (
        template_version_id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(template_id),
        version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        asset_manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(template_id, version),
        UNIQUE(template_id, definition_hash, asset_manifest_hash)
      );

      CREATE TABLE IF NOT EXISTS template_assets (
        template_version_id TEXT NOT NULL REFERENCES template_versions(template_version_id),
        asset_path TEXT NOT NULL,
        content_type TEXT,
        byte_length INTEGER NOT NULL,
        content_digest TEXT NOT NULL,
        bytes BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(template_version_id, asset_path)
      );

      CREATE TABLE IF NOT EXISTS template_design_sessions (
        draft_id TEXT PRIMARY KEY,
        template_id TEXT REFERENCES templates(template_id),
        base_template_version_id TEXT REFERENCES template_versions(template_version_id),
        metadata_json TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        status TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_authorizations (
        workspace_id TEXT PRIMARY KEY,
        canonical_directory TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        authorized_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_setup_drafts (
        task_setup_draft_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        template_version_id TEXT NOT NULL REFERENCES template_versions(template_version_id),
        workspace_id TEXT NOT NULL REFERENCES workspace_authorizations(workspace_id),
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        task_input_values_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_task_id TEXT UNIQUE REFERENCES tasks(task_id),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta_sessions (
        meta_session_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        meta_profile_option_id TEXT NOT NULL,
        meta_profile_json TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta_messages (
        meta_message_id TEXT PRIMARY KEY,
        meta_session_id TEXT NOT NULL REFERENCES meta_sessions(meta_session_id),
        owner_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta_patch_proposals (
        meta_patch_proposal_id TEXT PRIMARY KEY,
        meta_session_id TEXT NOT NULL REFERENCES meta_sessions(meta_session_id),
        owner_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        source_meta_profile_option_id TEXT NOT NULL,
        source_meta_profile_json TEXT NOT NULL,
        source_meta_session_revision INTEGER NOT NULL,
        target_revision INTEGER NOT NULL,
        operations_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        rationale TEXT NOT NULL,
        validation_issues_json TEXT NOT NULL,
        state TEXT NOT NULL,
        applied_target_revision INTEGER,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS meta_turns (
        meta_turn_id TEXT PRIMARY KEY,
        meta_session_id TEXT NOT NULL REFERENCES meta_sessions(meta_session_id),
        command_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        user_meta_message_id TEXT NOT NULL UNIQUE REFERENCES meta_messages(meta_message_id),
        assistant_meta_message_id TEXT NOT NULL UNIQUE,
        meta_patch_proposal_id TEXT NOT NULL UNIQUE,
        profile_json TEXT NOT NULL,
        mode TEXT NOT NULL,
        target_revision INTEGER NOT NULL,
        system_instructions TEXT NOT NULL,
        system_instructions_digest TEXT NOT NULL,
        output_schema_json TEXT NOT NULL,
        output_schema_digest TEXT NOT NULL,
        context_json TEXT NOT NULL,
        context_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'leased', 'provider_accepted', 'returned', 'rejected', 'ambiguous', 'failed')
        ),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        leased_from_status TEXT CHECK (
          leased_from_status IS NULL OR leased_from_status IN ('pending', 'provider_accepted', 'ambiguous')
        ),
        failure_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_architecture_snapshots (
        architecture_snapshot_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        template_id TEXT NOT NULL REFERENCES templates(template_id),
        template_version_id TEXT NOT NULL REFERENCES template_versions(template_version_id),
        template_definition_hash TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        task_input_values_json TEXT NOT NULL DEFAULT '[]',
        task_goal_content TEXT NOT NULL DEFAULT '',
        task_goal_content_digest TEXT NOT NULL DEFAULT '',
        task_goal_compiler_version TEXT NOT NULL DEFAULT 'task-goal/v1',
        workspace_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        architecture_snapshot_id TEXT NOT NULL REFERENCES task_architecture_snapshots(architecture_snapshot_id),
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        trashed_at TEXT,
        achievement_json TEXT,
        active_run_id TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        conductor_logical_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        run_number INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_commands (
        command_id TEXT PRIMARY KEY,
        command_type TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS template_assets_version_idx ON template_assets(template_version_id, asset_path);
      CREATE INDEX IF NOT EXISTS task_setup_drafts_owner_idx ON task_setup_drafts(owner_id, updated_at, task_setup_draft_id);
      CREATE UNIQUE INDEX IF NOT EXISTS meta_sessions_active_target_idx
        ON meta_sessions(owner_id, target_kind, target_id) WHERE state = 'active';
      CREATE INDEX IF NOT EXISTS meta_messages_session_idx ON meta_messages(meta_session_id, created_at, meta_message_id);
      CREATE INDEX IF NOT EXISTS meta_patch_proposals_session_idx
        ON meta_patch_proposals(meta_session_id, created_at, meta_patch_proposal_id);
      CREATE INDEX IF NOT EXISTS meta_turns_session_idx
        ON meta_turns(meta_session_id, created_at, meta_turn_id);
      CREATE INDEX IF NOT EXISTS meta_turns_ready_idx
        ON meta_turns(status, lease_until, created_at, meta_turn_id);
      CREATE UNIQUE INDEX IF NOT EXISTS meta_turns_active_session_idx
        ON meta_turns(meta_session_id)
        WHERE status IN ('pending', 'leased', 'provider_accepted', 'ambiguous');

    `);
    this.#createSessionIdOrchestrationTables();
    this.#upgradeLogicalSessionArchitectureV21();
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS session_id_logical_sessions_conductor_run_idx
        ON session_id_logical_sessions(run_id)
        WHERE session_kind = 'conductor';
    `);
    this.#createAcpV3SessionRuntimeTables();
    this.#migrationFailpoint?.("after_acp_v3_tables");
    this.#rebuildSessionIdInboxForConductorTargets();
    this.#rebuildSessionIdDeliveryForConductorTargets();
    this.#upgradeSessionIdAttentionOwnerV16();
    this.#upgradeSessionIdStopControlV18();
    this.#ensureColumn("tasks", "achievement_json", "TEXT");
    this.#ensureColumn("tasks", "trashed_at", "TEXT");
    this.#ensureColumn("template_versions", "asset_manifest_hash", `TEXT NOT NULL DEFAULT '${EMPTY_TEMPLATE_ASSET_MANIFEST_HASH}'`);
    this.#ensureColumn("task_architecture_snapshots", "task_input_values_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("task_architecture_snapshots", "task_goal_content", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("task_architecture_snapshots", "task_goal_content_digest", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("task_architecture_snapshots", "task_goal_compiler_version", "TEXT NOT NULL DEFAULT 'task-goal/v1'");
    this.#rebuildTemplateVersionsForAssetManifest();
    this.run(
      "UPDATE template_versions SET asset_manifest_hash = ? WHERE asset_manifest_hash IS NULL OR asset_manifest_hash = ''",
      EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
    );
    this.#backfillTaskGoalSnapshots();
    this.run(
      "INSERT OR REPLACE INTO runtime_meta(key, value) VALUES (?, ?)",
      "schema_version",
      "21",
    );
  }

  /**
   * v21 gives the Run-owned Conductor a first-class logical Session without
   * forging a Card slot. Existing rows remain Card generations and keep their
   * exact bytes/identities; only schema-v3 sessions require a frozen Profile.
   */
  #upgradeLogicalSessionArchitectureV21(): void {
    const columns = this.many<{ name: string; notnull: number }>(
      "PRAGMA table_info(session_id_logical_sessions)",
    );
    const slot = columns.find((column) => column.name === "card_session_slot_id");
    if (slot?.notnull === 0
      && columns.some((column) => column.name === "session_kind")
      && columns.some((column) => column.name === "architecture_schema_version")
      && columns.some((column) => column.name === "profile_revision_id")) return;
    this.#database.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      BEGIN IMMEDIATE;
      ALTER TABLE session_id_logical_sessions RENAME TO session_id_logical_sessions_v20_source;
      CREATE TABLE session_id_logical_sessions (
        session_id TEXT PRIMARY KEY,
        card_session_slot_id TEXT REFERENCES session_id_card_session_slots(card_session_slot_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_kind TEXT NOT NULL CHECK (session_kind IN ('conductor', 'card')),
        architecture_schema_version INTEGER NOT NULL CHECK (architecture_schema_version IN (2, 3)),
        agent_card_id TEXT NOT NULL,
        execution_profile_id TEXT,
        profile_revision_id TEXT,
        generation INTEGER NOT NULL CHECK (generation > 0),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('current', 'closed', 'faulted')),
        created_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE(card_session_slot_id, generation),
        UNIQUE(session_id, run_id),
        CHECK (
          (session_kind = 'conductor' AND card_session_slot_id IS NULL AND architecture_schema_version = 3)
          OR (session_kind = 'card' AND card_session_slot_id IS NOT NULL)
        ),
        CHECK (architecture_schema_version = 2 OR (execution_profile_id IS NOT NULL AND profile_revision_id IS NOT NULL)),
        CHECK ((lifecycle = 'current' AND closed_at IS NULL) OR lifecycle <> 'current')
      );
      INSERT INTO session_id_logical_sessions(
        session_id, card_session_slot_id, task_id, run_id, session_kind,
        architecture_schema_version, agent_card_id, execution_profile_id, profile_revision_id,
        generation, lifecycle, created_at, closed_at
      )
      SELECT source.session_id, source.card_session_slot_id, source.task_id, source.run_id, 'card',
             CASE json_extract(architecture.definition_json, '$.schemaVersion') WHEN 3 THEN 3 ELSE 2 END,
             source.agent_card_id, source.execution_profile_id,
             CASE json_extract(architecture.definition_json, '$.schemaVersion')
               WHEN 3 THEN (
                 SELECT json_extract(profile.value, '$.profileRevisionId')
                 FROM json_each(architecture.definition_json, '$.executionProfiles') AS profile
                 WHERE json_extract(profile.value, '$.executionProfileId') = source.execution_profile_id
                 LIMIT 1
               )
               ELSE NULL
             END,
             source.generation,
             source.lifecycle, source.created_at, source.closed_at
      FROM session_id_logical_sessions_v20_source AS source
      JOIN task_architecture_snapshots AS architecture ON architecture.task_id = source.task_id;
      DROP TABLE session_id_logical_sessions_v20_source;
      COMMIT;
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `);
    const violation = this.#database.prepare("PRAGMA foreign_key_check(session_id_logical_sessions)").get();
    if (violation) throw new Error("session_id_logical_session_v21_foreign_key_violation");
  }

  /**
   * ACP v3 execution-owner tables are deliberately separate from the retained
   * direct-Provider Binding/outbox tables. Only Workspace opaque identifiers
   * and contract-validated JSON records are representable here; Host-private
   * ACP recovery identity belongs to the Runtime data-directory map instead.
   */
  #createAcpV3SessionRuntimeTables(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS session_id_acp_v3_bindings (
        binding_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 3),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        logical_session_id TEXT NOT NULL REFERENCES session_id_logical_sessions(session_id),
        agent_card_id TEXT NOT NULL,
        execution_profile_id TEXT NOT NULL,
        profile_revision_id TEXT NOT NULL,
        provider_family TEXT NOT NULL CHECK (provider_family IN ('opencode', 'codex', 'claude-code')),
        binding_handle TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'recovering', 'released', 'unrecoverable')),
        recoverable INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(binding_id, revision),
        CHECK (status NOT IN ('released', 'unrecoverable') OR recoverable = 0)
      );

      CREATE TABLE IF NOT EXISTS session_id_acp_v3_current_bindings (
        logical_session_id TEXT PRIMARY KEY REFERENCES session_id_logical_sessions(session_id),
        binding_id TEXT NOT NULL UNIQUE REFERENCES session_id_acp_v3_bindings(binding_id),
        binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_id_acp_v3_execution_runtimes (
        session_execution_runtime_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        logical_session_id TEXT NOT NULL UNIQUE REFERENCES session_id_logical_sessions(session_id),
        state TEXT NOT NULL CHECK (state IN ('idle', 'executing', 'reconciling', 'closed')),
        active_attempt_id TEXT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((state IN ('executing', 'reconciling')) = (active_attempt_id IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS session_id_acp_v3_execution_attempts (
        session_execution_attempt_id TEXT PRIMARY KEY,
        session_execution_runtime_id TEXT NOT NULL REFERENCES session_id_acp_v3_execution_runtimes(session_execution_runtime_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        logical_session_id TEXT NOT NULL REFERENCES session_id_logical_sessions(session_id),
        binding_id TEXT NOT NULL REFERENCES session_id_acp_v3_bindings(binding_id),
        binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
        execution_profile_id TEXT NOT NULL,
        profile_revision_id TEXT NOT NULL,
        input_submission_id TEXT NOT NULL,
        orchestration_session_turn_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'awaiting_receipt', 'active', 'waiting_for_interaction',
          'candidate_observed', 'reconciling', 'settled'
        )),
        record_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_execution_runtime_id, input_submission_id)
      );

      CREATE TABLE IF NOT EXISTS session_id_acp_v3_provider_effect_intents (
        provider_effect_intent_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        command_type TEXT NOT NULL CHECK (command_type IN (
          'session_runtime.submit_delivery', 'session_runtime.reconcile_attempt',
          'session_runtime.request_interrupt', 'session_runtime.respond_interaction'
        )),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        logical_session_id TEXT NOT NULL REFERENCES session_id_logical_sessions(session_id),
        session_execution_runtime_id TEXT NOT NULL REFERENCES session_id_acp_v3_execution_runtimes(session_execution_runtime_id),
        session_execution_attempt_id TEXT NOT NULL REFERENCES session_id_acp_v3_execution_attempts(session_execution_attempt_id),
        binding_id TEXT NOT NULL REFERENCES session_id_acp_v3_bindings(binding_id),
        binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'suppressed')),
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, command_type, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS session_id_acp_v3_binding_retirement_intents (
        binding_retirement_intent_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        logical_session_id TEXT NOT NULL REFERENCES session_id_logical_sessions(session_id),
        binding_id TEXT NOT NULL REFERENCES session_id_acp_v3_bindings(binding_id),
        binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'retiring', 'released', 'unknown')),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, binding_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS session_id_acp_v3_bindings_session_idx
        ON session_id_acp_v3_bindings(logical_session_id, created_at, binding_id);
      CREATE INDEX IF NOT EXISTS session_id_acp_v3_attempts_runtime_idx
        ON session_id_acp_v3_execution_attempts(session_execution_runtime_id, created_at, session_execution_attempt_id);
      CREATE INDEX IF NOT EXISTS session_id_acp_v3_effects_attempt_idx
        ON session_id_acp_v3_provider_effect_intents(session_execution_attempt_id, created_at, provider_effect_intent_id);
      CREATE INDEX IF NOT EXISTS session_id_acp_v3_retirements_binding_idx
        ON session_id_acp_v3_binding_retirement_intents(binding_id, created_at, binding_retirement_intent_id);
    `);
  }

  /**
   * Canonical Session-ID orchestration schema. Fresh databases contain only
   * these execution owners. Superseded tables found during an upgrade remain
   * untouched and are recorded only by table name for explicit operator audit.
   */
  #createSessionIdOrchestrationTables(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS session_id_tasks (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_id_card_session_slots (
        card_session_slot_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        agent_card_id TEXT NOT NULL,
        current_session_id TEXT,
        latest_generation INTEGER NOT NULL CHECK (latest_generation >= 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, agent_card_id),
        UNIQUE(card_session_slot_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS session_id_logical_sessions (
        session_id TEXT PRIMARY KEY,
        card_session_slot_id TEXT REFERENCES session_id_card_session_slots(card_session_slot_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_kind TEXT NOT NULL CHECK (session_kind IN ('conductor', 'card')),
        architecture_schema_version INTEGER NOT NULL CHECK (architecture_schema_version IN (2, 3)),
        agent_card_id TEXT NOT NULL,
        execution_profile_id TEXT,
        profile_revision_id TEXT,
        generation INTEGER NOT NULL CHECK (generation > 0),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('current', 'closed', 'faulted')),
        created_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE(card_session_slot_id, generation),
        UNIQUE(session_id, run_id),
        CHECK (
          (session_kind = 'conductor' AND card_session_slot_id IS NULL AND architecture_schema_version = 3)
          OR (session_kind = 'card' AND card_session_slot_id IS NOT NULL)
        ),
        CHECK (architecture_schema_version = 2 OR (execution_profile_id IS NOT NULL AND profile_revision_id IS NOT NULL)),
        CHECK ((lifecycle = 'current' AND closed_at IS NULL) OR lifecycle <> 'current')
      );

      CREATE TABLE IF NOT EXISTS session_id_conductor_planning_fences (
        planning_fence_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        source_command_id TEXT NOT NULL,
        previous_conductor_session_turn_id TEXT,
        current_conductor_session_turn_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, source_command_id)
      );

      CREATE TABLE IF NOT EXISTS session_id_session_messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        source_session_id TEXT REFERENCES session_id_logical_sessions(session_id),
        source_session_turn_id TEXT,
        source_human_intervention_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('task_goal', 'user_input', 'conductor_forward', 'agent_final', 'runtime_notice')),
        content TEXT NOT NULL,
        canonical_content_json TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_id_relay_blocks (
        relay_block_id TEXT PRIMARY KEY,
        source_message_id TEXT NOT NULL REFERENCES session_id_session_messages(message_id),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        suggested_target_agent_card_ids_json TEXT NOT NULL,
        suggested_audience TEXT CHECK (suggested_audience IS NULL OR suggested_audience IN ('one', 'publish')),
        topic TEXT,
        format TEXT NOT NULL CHECK (format IN ('text/markdown', 'application/json')),
        content TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        source_start INTEGER NOT NULL,
        source_end INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_message_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS session_id_message_forwards (
        forward_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        decided_by_session_turn_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        new_content_digest TEXT,
        rendered_message_id TEXT NOT NULL UNIQUE REFERENCES session_id_session_messages(message_id),
        created_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS session_id_message_forward_refs (
        forward_id TEXT NOT NULL REFERENCES session_id_message_forwards(forward_id),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('full_message', 'relay_block')),
        source_message_id TEXT NOT NULL REFERENCES session_id_session_messages(message_id),
        relay_block_id TEXT REFERENCES session_id_relay_blocks(relay_block_id),
        content_digest TEXT NOT NULL,
        PRIMARY KEY(forward_id, ordinal),
        CHECK (
          (kind = 'full_message' AND relay_block_id IS NULL)
          OR (kind = 'relay_block' AND relay_block_id IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS session_id_human_interventions (
        human_intervention_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('direct_message', 'interrupt_then_send', 'scoped_interrupt', 'attention_response')),
        state TEXT NOT NULL CHECK (state IN ('accepted', 'held', 'delivered', 'abandoned', 'cancelled_by_task_stop', 'resolved')),
        card_message_id TEXT REFERENCES session_id_session_messages(message_id),
        conductor_mirror_message_id TEXT REFERENCES session_id_session_messages(message_id),
        affected_session_turn_id TEXT,
        attention_id TEXT,
        authenticated_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS session_id_session_inbox_items (
        inbox_item_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        target_session_id TEXT NOT NULL REFERENCES session_id_logical_sessions(session_id),
        rendered_message_id TEXT NOT NULL REFERENCES session_id_session_messages(message_id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        priority TEXT NOT NULL CHECK (priority IN ('notice', 'human', 'ordinary')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'held_by_human_intervention', 'leased', 'handed', 'handled', 'ambiguous', 'suppressed')),
        causal_predecessor_inbox_item_id TEXT REFERENCES session_id_session_inbox_items(inbox_item_id),
        human_intervention_id TEXT REFERENCES session_id_human_interventions(human_intervention_id),
        forward_id TEXT REFERENCES session_id_message_forwards(forward_id),
        lease_id TEXT,
        lease_expires_at TEXT,
        reason TEXT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(target_session_id, rendered_message_id),
        UNIQUE(target_session_id, sequence),
        CHECK (state <> 'held_by_human_intervention' OR human_intervention_id IS NOT NULL),
        CHECK (state <> 'suppressed' OR reason IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS session_id_input_submissions (
        input_submission_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL,
        source_inbox_item_id TEXT NOT NULL UNIQUE REFERENCES session_id_session_inbox_items(inbox_item_id),
        content_message_id TEXT NOT NULL REFERENCES session_id_session_messages(message_id),
        command_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'handed', 'accepted', 'returned', 'ambiguous', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_id_session_turns (
        session_turn_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL,
        input_submission_id TEXT NOT NULL UNIQUE REFERENCES session_id_input_submissions(input_submission_id),
        source_conductor_session_turn_id TEXT,
        trigger TEXT NOT NULL CHECK (trigger IN ('task_goal', 'human', 'conductor_send', 'session_return', 'attention', 'recovery')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'returned', 'completed', 'failed', 'interrupted', 'cancelled', 'ambiguous')),
        final_message_id TEXT UNIQUE REFERENCES session_id_session_messages(message_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT,
        CHECK (final_message_id IS NULL OR state IN ('returned', 'completed'))
      );

      CREATE TABLE IF NOT EXISTS session_id_session_control_audits (
        session_control_audit_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('conductor_interrupt', 'human_interrupt', 'task_stop', 'close')),
        state TEXT NOT NULL CHECK (state IN ('requested', 'accepted', 'confirmed', 'unknown', 'rejected', 'closed')),
        affected_inbox_item_ids_json TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        settled_at TEXT,
        reason TEXT,
        UNIQUE(task_id, run_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS session_id_workspace_effect_intents (
        workspace_effect_intent_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        publisher_session_id TEXT NOT NULL REFERENCES session_id_logical_sessions(session_id),
        publisher_session_turn_id TEXT NOT NULL,
        provider_call_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        workspace_relative_path TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'unknown', 'failed')),
        observation_id TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, idempotency_key),
        UNIQUE(publisher_session_id, provider_call_id)
      );

      CREATE TABLE IF NOT EXISTS session_id_workspace_file_observations (
        workspace_file_observation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT REFERENCES task_runs(run_id),
        workspace_effect_intent_id TEXT REFERENCES session_id_workspace_effect_intents(workspace_effect_intent_id),
        workspace_relative_path TEXT NOT NULL,
        content_digest TEXT,
        byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
        state TEXT NOT NULL CHECK (state IN ('available', 'missing', 'changed', 'too_large', 'unsupported')),
        source TEXT NOT NULL CHECK (source IN ('verified_tool', 'unverified')),
        observed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_id_provider_bindings (
        binding_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL UNIQUE,
        agent_card_id TEXT NOT NULL,
        execution_profile_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('opencode', 'codex', 'claude-code')),
        provider_host_id TEXT,
        native_binding_ref TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'unbound', 'binding_effect_accepted', 'active', 'recovering', 'released', 'unrecoverable'
        )),
        recoverable INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(binding_id, revision)
      );

      CREATE TABLE IF NOT EXISTS session_id_provider_facts (
        provider_fact_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES session_id_provider_bindings(binding_id),
        binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
        provider TEXT NOT NULL CHECK (provider IN ('opencode', 'codex', 'claude-code')),
        kind TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        fact_fingerprint TEXT NOT NULL,
        deduplication_json TEXT NOT NULL,
        correlation_json TEXT NOT NULL,
        evidence_reference_id TEXT,
        payload_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE(binding_id, dedup_key)
      );

      CREATE TABLE IF NOT EXISTS session_id_attentions (
        attention_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL,
        binding_id TEXT NOT NULL REFERENCES session_id_provider_bindings(binding_id),
        binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
        session_turn_id TEXT NOT NULL REFERENCES session_id_session_turns(session_turn_id),
        input_submission_id TEXT NOT NULL REFERENCES session_id_input_submissions(input_submission_id),
        native_request_id TEXT NOT NULL,
        source_provider_fact_id TEXT NOT NULL UNIQUE REFERENCES session_id_provider_facts(provider_fact_id),
        request_json TEXT NOT NULL,
        response_json TEXT,
        response_command_id TEXT UNIQUE,
        human_intervention_id TEXT UNIQUE,
        conductor_mirror_message_id TEXT UNIQUE,
        response_outbox_id TEXT UNIQUE,
        status TEXT NOT NULL CHECK (status IN (
          'requested', 'response_staged', 'effect_accepted', 'resolved', 'stale', 'unknown'
        )),
        revision INTEGER NOT NULL CHECK (revision > 0),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT,
        UNIQUE(binding_id, binding_revision, native_request_id),
        CHECK (status NOT IN ('response_staged', 'effect_accepted') OR response_command_id IS NOT NULL)
      );

      CREATE TABLE IF NOT EXISTS session_id_command_receipts (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        command_kind TEXT NOT NULL CHECK (command_kind IN ('invoke_agent', 'send_to_session', 'interrupt_session', 'close_session')),
        idempotency_key TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS session_id_ui_command_receipts (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        command_kind TEXT NOT NULL CHECK (command_kind IN (
          'task.submit_input',
          'session.send_human_message',
          'session.abandon_human_message',
          'session.request_interrupt',
          'session.respond_interaction',
          'session.respond_attention',
          'task.stop',
          'workspace.preview_file'
        )),
        idempotency_key TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS session_id_provider_effect_outbox (
        outbox_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL,
        session_turn_id TEXT,
        session_control_audit_id TEXT REFERENCES session_id_session_control_audits(session_control_audit_id),
        attention_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('ensure_binding', 'submit_delivery', 'request_interrupt', 'respond_attention', 'release_binding')),
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'accepted', 'rejected', 'unknown', 'suppressed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_until TEXT,
        receipt_json TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, kind, idempotency_key),
        CHECK ((state = 'leased' AND lease_until IS NOT NULL) OR state <> 'leased'),
        CHECK (state <> 'suppressed' OR reason IS NOT NULL),
        CHECK ((kind = 'respond_attention') = (attention_id IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS session_id_task_permanent_delete_intents (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
        expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
        payload_fingerprint TEXT NOT NULL,
        prepared_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_id_task_permanent_delete_tombstones (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS session_id_one_current_generation_idx
        ON session_id_logical_sessions(card_session_slot_id)
        WHERE lifecycle = 'current';
      CREATE INDEX IF NOT EXISTS session_id_sessions_run_idx
        ON session_id_logical_sessions(run_id, agent_card_id, generation);
      CREATE INDEX IF NOT EXISTS session_id_inbox_ready_idx
        ON session_id_session_inbox_items(target_session_id, state, priority, sequence);
      CREATE INDEX IF NOT EXISTS session_id_controls_session_idx
        ON session_id_session_control_audits(session_id, requested_at);
      CREATE INDEX IF NOT EXISTS session_id_observations_task_idx
        ON session_id_workspace_file_observations(task_id, observed_at);
      CREATE UNIQUE INDEX IF NOT EXISTS session_id_workspace_effect_provider_call_idx
        ON session_id_workspace_effect_intents(task_id, provider_call_id);
      CREATE INDEX IF NOT EXISTS session_id_task_delete_tombstones_task_idx
        ON session_id_task_permanent_delete_tombstones(task_id, deleted_at);

      CREATE TRIGGER IF NOT EXISTS session_id_task_update_rejected_while_permanent_delete_pending
      BEFORE UPDATE ON tasks
      WHEN EXISTS (
        SELECT 1 FROM session_id_task_permanent_delete_intents intent WHERE intent.task_id = OLD.task_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'session_id_task_permanent_delete_in_progress');
      END;
    `);
    this.#createFreshDirectProtocolIndexes();

    // A pre-release v13 database can only have staging rows produced by this
    // checkout. Adding the nullable provenance column does not interpret or
    // transform any legacy production protocol row.
    this.#ensureColumn("session_id_session_turns", "source_conductor_session_turn_id", "TEXT");
  }

  #createFreshDirectProtocolIndexes(): void {
    if (!this.#retainedDirectProtocolTables.has("session_id_provider_effect_outbox")) {
      this.#database.exec(`CREATE INDEX IF NOT EXISTS session_id_provider_effect_ready_idx
        ON session_id_provider_effect_outbox(state, lease_until, created_at, outbox_id)`);
    }
    if (!this.#retainedDirectProtocolTables.has("session_id_provider_bindings")) {
      this.#database.exec(`CREATE INDEX IF NOT EXISTS session_id_provider_bindings_run_idx
        ON session_id_provider_bindings(run_id, agent_card_id, binding_id)`);
    }
    if (!this.#retainedDirectProtocolTables.has("session_id_provider_facts")) {
      this.#database.exec(`CREATE INDEX IF NOT EXISTS session_id_provider_facts_binding_idx
        ON session_id_provider_facts(binding_id, observed_at, provider_fact_id)`);
    }
    if (!this.#retainedDirectProtocolTables.has("session_id_attentions")) {
      this.#database.exec(`CREATE INDEX IF NOT EXISTS session_id_attentions_run_idx
        ON session_id_attentions(run_id, session_id, status, created_at, attention_id)`);
    }
  }

  /** v18 advances only the current Coordinator control table. */
  #upgradeSessionIdStopControlV18(): void {
    const controlsCurrent = this.#tableDefinitionIncludes("session_id_session_control_audits", "'task_stop'");
    if (controlsCurrent) return;
    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.#database.exec(`
        DROP TABLE IF EXISTS session_id_session_control_audits_v18_current;
        CREATE TABLE session_id_session_control_audits_v18_current (
          session_control_audit_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          run_id TEXT NOT NULL REFERENCES task_runs(run_id),
          session_id TEXT NOT NULL,
          command_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('conductor_interrupt', 'human_interrupt', 'task_stop', 'close')),
          state TEXT NOT NULL CHECK (state IN ('requested', 'accepted', 'confirmed', 'unknown', 'rejected', 'closed')),
          affected_inbox_item_ids_json TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          settled_at TEXT,
          reason TEXT,
          UNIQUE(task_id, run_id, idempotency_key)
        );
        INSERT INTO session_id_session_control_audits_v18_current(
          session_control_audit_id, task_id, run_id, session_id, command_id,
          idempotency_key, kind, state, affected_inbox_item_ids_json,
          requested_at, settled_at, reason
        ) SELECT
          session_control_audit_id, task_id, run_id, session_id, command_id,
          idempotency_key, kind, state, affected_inbox_item_ids_json,
          requested_at, settled_at, reason
        FROM session_id_session_control_audits;
        DROP TABLE session_id_session_control_audits;
        ALTER TABLE session_id_session_control_audits_v18_current
          RENAME TO session_id_session_control_audits;
        CREATE INDEX session_id_controls_session_idx
          ON session_id_session_control_audits(session_id, requested_at);
      `);
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
    const violation = this.#database.prepare(
      "PRAGMA foreign_key_check(session_id_session_control_audits)",
    ).get() as { table?: unknown } | undefined;
    if (violation) {
      throw new Error(`runtime_store_session_id_stop_v18_fk_violation:${String(violation.table ?? "unknown")}`);
    }
  }

  /**
   * v14 incorrectly constrained the shared target lane to Card generations.
   * A Conductor is a Task Run session, not a fabricated Card Slot, so v15
   * keeps target identity opaque and lets the owner repository validate it
   * against either the new Card generation table or task_runs.
   */
  #rebuildSessionIdInboxForConductorTargets(): void {
    if (!this.#tableHasForeignKey(
      "session_id_session_inbox_items",
      "target_session_id",
      "session_id_logical_sessions",
    )) return;
    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.#database.exec(`
        CREATE TABLE session_id_session_inbox_items_v15 (
          inbox_item_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          run_id TEXT NOT NULL REFERENCES task_runs(run_id),
          target_session_id TEXT NOT NULL,
          rendered_message_id TEXT NOT NULL REFERENCES session_id_session_messages(message_id),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          priority TEXT NOT NULL CHECK (priority IN ('notice', 'human', 'ordinary')),
          state TEXT NOT NULL CHECK (state IN (
            'pending', 'held_by_human_intervention', 'leased', 'handed', 'handled', 'ambiguous', 'suppressed'
          )),
          causal_predecessor_inbox_item_id TEXT REFERENCES session_id_session_inbox_items_v15(inbox_item_id),
          human_intervention_id TEXT REFERENCES session_id_human_interventions(human_intervention_id),
          forward_id TEXT REFERENCES session_id_message_forwards(forward_id),
          lease_id TEXT,
          lease_expires_at TEXT,
          reason TEXT,
          revision INTEGER NOT NULL CHECK (revision > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(target_session_id, rendered_message_id),
          UNIQUE(target_session_id, sequence),
          CHECK (state <> 'held_by_human_intervention' OR human_intervention_id IS NOT NULL),
          CHECK (state <> 'suppressed' OR reason IS NOT NULL)
        );
        INSERT INTO session_id_session_inbox_items_v15(
          inbox_item_id, task_id, run_id, target_session_id, rendered_message_id,
          sequence, priority, state, causal_predecessor_inbox_item_id,
          human_intervention_id, forward_id, lease_id, lease_expires_at, reason,
          revision, created_at, updated_at
        )
        SELECT
          inbox_item_id, task_id, run_id, target_session_id, rendered_message_id,
          sequence, priority, state, causal_predecessor_inbox_item_id,
          human_intervention_id, forward_id, lease_id, lease_expires_at, reason,
          revision, created_at, updated_at
        FROM session_id_session_inbox_items;
        DROP TABLE session_id_session_inbox_items;
        ALTER TABLE session_id_session_inbox_items_v15 RENAME TO session_id_session_inbox_items;
        CREATE INDEX session_id_inbox_ready_idx
          ON session_id_session_inbox_items(target_session_id, state, priority, sequence);
      `);
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
    const violation = this.#database.prepare(
      "PRAGMA foreign_key_check(session_id_session_inbox_items)",
    ).get() as { table?: unknown } | undefined;
    if (violation) throw new Error(`runtime_store_session_id_inbox_v15_fk_violation:${String(violation.table ?? "unknown")}`);
  }

  /** v15 advances only the current Input/Turn delivery records. */
  #rebuildSessionIdDeliveryForConductorTargets(): void {
    const inputNeedsRebuild = this.#tableHasForeignKey(
      "session_id_input_submissions",
      "session_id",
      "session_id_logical_sessions",
    );
    const turnNeedsRebuild = this.#tableHasForeignKey(
      "session_id_session_turns",
      "session_id",
      "session_id_logical_sessions",
    );
    if (!inputNeedsRebuild && !turnNeedsRebuild) return;

    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      if (inputNeedsRebuild) this.#database.exec(`
        CREATE TABLE session_id_input_submissions_v15 (
          input_submission_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          run_id TEXT NOT NULL REFERENCES task_runs(run_id),
          session_id TEXT NOT NULL,
          source_inbox_item_id TEXT NOT NULL UNIQUE REFERENCES session_id_session_inbox_items(inbox_item_id),
          content_message_id TEXT NOT NULL REFERENCES session_id_session_messages(message_id),
          command_id TEXT NOT NULL UNIQUE,
          idempotency_key TEXT NOT NULL UNIQUE,
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          state TEXT NOT NULL CHECK (state IN (
            'pending', 'handed', 'accepted', 'returned', 'ambiguous', 'failed', 'cancelled'
          )),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO session_id_input_submissions_v15(
          input_submission_id, task_id, run_id, session_id, source_inbox_item_id,
          content_message_id, command_id, idempotency_key, sequence, state, created_at, updated_at
        ) SELECT
          input_submission_id, task_id, run_id, session_id, source_inbox_item_id,
          content_message_id, command_id, idempotency_key, sequence, state, created_at, updated_at
        FROM session_id_input_submissions;
        DROP TABLE session_id_input_submissions;
        ALTER TABLE session_id_input_submissions_v15 RENAME TO session_id_input_submissions;
        CREATE INDEX session_id_inputs_session_idx
          ON session_id_input_submissions(session_id, sequence);
      `);
      if (turnNeedsRebuild) this.#database.exec(`
        CREATE TABLE session_id_session_turns_v15 (
          session_turn_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          run_id TEXT NOT NULL REFERENCES task_runs(run_id),
          session_id TEXT NOT NULL,
          input_submission_id TEXT NOT NULL UNIQUE REFERENCES session_id_input_submissions(input_submission_id),
          source_conductor_session_turn_id TEXT,
          trigger TEXT NOT NULL CHECK (trigger IN (
            'task_goal', 'human', 'conductor_send', 'session_return', 'attention', 'recovery'
          )),
          state TEXT NOT NULL CHECK (state IN (
            'pending', 'active', 'returned', 'completed', 'failed', 'interrupted', 'cancelled', 'ambiguous'
          )),
          final_message_id TEXT UNIQUE REFERENCES session_id_session_messages(message_id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          settled_at TEXT,
          CHECK (final_message_id IS NULL OR state IN ('returned', 'completed'))
        );
        INSERT INTO session_id_session_turns_v15(
          session_turn_id, task_id, run_id, session_id, input_submission_id,
          source_conductor_session_turn_id, trigger, state, final_message_id,
          created_at, updated_at, settled_at
        ) SELECT
          session_turn_id, task_id, run_id, session_id, input_submission_id,
          source_conductor_session_turn_id, trigger, state, final_message_id,
          created_at, updated_at, settled_at
        FROM session_id_session_turns;
        DROP TABLE session_id_session_turns;
        ALTER TABLE session_id_session_turns_v15 RENAME TO session_id_session_turns;
        CREATE INDEX session_id_turns_session_idx
          ON session_id_session_turns(session_id, created_at);
      `);
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
    for (const table of [
      ...(inputNeedsRebuild ? ["session_id_input_submissions"] : []),
      ...(turnNeedsRebuild ? ["session_id_session_turns"] : []),
    ]) {
      const violation = this.#database.prepare(`PRAGMA foreign_key_check(${table})`).get() as { table?: unknown } | undefined;
      if (violation) {
        throw new Error(`runtime_store_session_id_delivery_v15_fk_violation:${String(violation.table ?? "unknown")}`);
      }
    }
  }

  /** v16 advances current HumanIntervention and UI receipt ownership only. */
  #upgradeSessionIdAttentionOwnerV16(): void {
    this.#ensureColumn("session_id_human_interventions", "attention_id", "TEXT");
    this.#ensureColumn("session_id_human_interventions", "authenticated_user_id", "TEXT");
    const humanNeedsRebuild = this.#tableHasForeignKey(
      "session_id_human_interventions",
      "target_session_id",
      "session_id_logical_sessions",
    );
    const receiptNeedsRebuild = !this.#tableDefinitionIncludes(
      "session_id_ui_command_receipts",
      "session.respond_attention",
    ) || !this.#tableDefinitionIncludes(
      "session_id_ui_command_receipts",
      "session.respond_interaction",
    ) || !this.#tableDefinitionIncludes(
      "session_id_ui_command_receipts",
      "session.abandon_human_message",
    );
    if (!humanNeedsRebuild && !receiptNeedsRebuild) return;

    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      if (humanNeedsRebuild) this.#database.exec(`
        DROP TABLE IF EXISTS session_id_human_interventions_v16;
        CREATE TABLE session_id_human_interventions_v16 (
          human_intervention_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          run_id TEXT NOT NULL REFERENCES task_runs(run_id),
          command_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          target_session_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN (
            'direct_message', 'interrupt_then_send', 'scoped_interrupt', 'attention_response'
          )),
          state TEXT NOT NULL CHECK (state IN (
            'accepted', 'held', 'delivered', 'abandoned', 'cancelled_by_task_stop', 'resolved'
          )),
          card_message_id TEXT REFERENCES session_id_session_messages(message_id),
          conductor_mirror_message_id TEXT REFERENCES session_id_session_messages(message_id),
          affected_session_turn_id TEXT,
          attention_id TEXT,
          authenticated_user_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(task_id, run_id, idempotency_key)
        );
        INSERT INTO session_id_human_interventions_v16(
          human_intervention_id, task_id, run_id, command_id, idempotency_key,
          target_session_id, mode, state, card_message_id, conductor_mirror_message_id,
          affected_session_turn_id, attention_id, authenticated_user_id, created_at, updated_at
        ) SELECT
          human_intervention_id, task_id, run_id, command_id, idempotency_key,
          target_session_id, mode, state, card_message_id, conductor_mirror_message_id,
          affected_session_turn_id, attention_id, authenticated_user_id, created_at, updated_at
        FROM session_id_human_interventions;
        DROP TABLE session_id_human_interventions;
        ALTER TABLE session_id_human_interventions_v16 RENAME TO session_id_human_interventions;
      `);
      if (receiptNeedsRebuild) this.#database.exec(`
        DROP TABLE IF EXISTS session_id_ui_command_receipts_v16;
        CREATE TABLE session_id_ui_command_receipts_v16 (
          command_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          run_id TEXT NOT NULL REFERENCES task_runs(run_id),
          command_kind TEXT NOT NULL CHECK (command_kind IN (
            'task.submit_input',
            'session.send_human_message',
            'session.abandon_human_message',
            'session.request_interrupt',
            'session.respond_interaction',
            'session.respond_attention',
            'task.stop',
            'workspace.preview_file'
          )),
          idempotency_key TEXT NOT NULL,
          payload_fingerprint TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(task_id, run_id, idempotency_key)
        );
        INSERT INTO session_id_ui_command_receipts_v16(
          command_id, task_id, run_id, command_kind, idempotency_key,
          payload_fingerprint, result_json, created_at
        ) SELECT
          command_id, task_id, run_id, command_kind, idempotency_key,
          payload_fingerprint, result_json, created_at
        FROM session_id_ui_command_receipts;
        DROP TABLE session_id_ui_command_receipts;
        ALTER TABLE session_id_ui_command_receipts_v16 RENAME TO session_id_ui_command_receipts;
      `);
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
    for (const table of [
      ...(humanNeedsRebuild ? ["session_id_human_interventions"] : []),
    ]) {
      const violation = this.#database.prepare(`PRAGMA foreign_key_check(${table})`).get() as { table?: unknown } | undefined;
      if (violation) {
        throw new Error(`runtime_store_session_id_attention_v16_fk_violation:${String(violation.table ?? "unknown")}`);
      }
    }
  }

  #backfillTaskGoalSnapshots(): void {
    const rows = this.#database.prepare(
      `SELECT snapshot.architecture_snapshot_id, task.title, task.goal
       FROM task_architecture_snapshots snapshot
       JOIN session_id_tasks target_task ON target_task.task_id = snapshot.task_id
       JOIN tasks task ON task.task_id = snapshot.task_id
       WHERE snapshot.task_goal_content = '' OR snapshot.task_goal_content_digest = ''`,
    ).all() as readonly { architecture_snapshot_id?: unknown; title?: unknown; goal?: unknown }[];
    for (const row of rows) {
      if (typeof row.architecture_snapshot_id !== "string" || typeof row.title !== "string" || typeof row.goal !== "string") {
        throw new Error("runtime_store_task_goal_backfill_invalid");
      }
      const title = row.title.replace(/\r\n?/g, "\n").trim();
      const goal = row.goal.replace(/\r\n?/g, "\n").trim();
      if (title.includes("\n") || !title || !goal) throw new Error("runtime_store_task_goal_backfill_invalid");
      const content = `Task title: ${title}\nTask goal:\n${goal}\nTask inputs:\n(none)\n`;
      this.run(
        `UPDATE task_architecture_snapshots
         SET task_goal_content = ?, task_goal_content_digest = ?, task_goal_compiler_version = ?
         WHERE architecture_snapshot_id = ?`,
        content,
        hashDefinition(content),
        "task-goal/v1",
        row.architecture_snapshot_id,
      );
    }
  }

  #findSupersededProtocolTables(): readonly string[] {
    const existing = new Set(
      (this.#database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as readonly { name?: unknown }[])
        .flatMap((row) => typeof row.name === "string" ? [row.name] : []),
    );
    return SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST.filter((table) => existing.has(table));
  }

  #findRetainedDirectProtocolTables(): readonly string[] {
    const existing = new Set(
      (this.#database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as readonly { name?: unknown }[])
        .flatMap((row) => typeof row.name === "string" ? [row.name] : []),
    );
    return RETAINED_DIRECT_PROTOCOL_TABLES.filter((table) => existing.has(table));
  }

  #recordSupersededProtocolTables(tables: readonly string[]): void {
    this.run(
      "INSERT OR REPLACE INTO runtime_meta(key, value) VALUES (?, ?)",
      SUPERSEDED_PROTOCOL_META_KEY,
      encodeJson(tables),
    );
  }

  #tableExists(table: string): boolean {
    return this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  }

  #tableHasForeignKey(table: string, column: string, targetTable: string): boolean {
    if (!this.#tableExists(table)) return false;
    return (this.#database.prepare(`PRAGMA foreign_key_list(${table})`).all() as readonly { from?: unknown; table?: unknown }[])
      .some((entry) => entry.from === column && entry.table === targetTable);
  }

  #tableDefinitionIncludes(table: string, fragment: string): boolean {
    const row = this.#database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql?: unknown } | undefined;
    return typeof row?.sql === "string" && row.sql.includes(fragment);
  }

  #ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.#database.prepare(`PRAGMA table_info(${table})`).all() as readonly { name?: unknown }[];
    if (columns.some((entry) => entry.name === column)) return;
    this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }

  /**
   * Schema v3 made definition hash alone unique. v4 makes the immutable asset
   * manifest part of Version identity, so a definition with different assets
   * is representable but can never overwrite/reuse the old Version.
   */
  #rebuildTemplateVersionsForAssetManifest(): void {
    const legacyIndex = (this.#database.prepare("PRAGMA index_list('template_versions')").all() as readonly { name?: unknown; unique?: unknown }[])
      .find((index) => {
        if (index.unique !== 1 || typeof index.name !== "string") return false;
        const quoted = index.name.replace(/"/g, '""');
        const fields = this.#database.prepare(`PRAGMA index_info("${quoted}")`).all() as readonly { name?: unknown; seqno?: unknown }[];
        return fields
          .slice()
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map((field) => field.name)
          .join(",") === "template_id,definition_hash";
      });
    if (!legacyIndex) return;
    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.#database.exec(`
        CREATE TABLE template_versions_v4 (
          template_version_id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL REFERENCES templates(template_id),
          version INTEGER NOT NULL,
          schema_version INTEGER NOT NULL,
          definition_json TEXT NOT NULL,
          definition_hash TEXT NOT NULL,
          asset_manifest_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          published_at TEXT NOT NULL,
          UNIQUE(template_id, version),
          UNIQUE(template_id, definition_hash, asset_manifest_hash)
        );
        INSERT INTO template_versions_v4(template_version_id, template_id, version, schema_version, definition_json, definition_hash, asset_manifest_hash, created_at, published_at)
        SELECT template_version_id, template_id, version, schema_version, definition_json, definition_hash,
          COALESCE(NULLIF(asset_manifest_hash, ''), '${EMPTY_TEMPLATE_ASSET_MANIFEST_HASH}'), created_at, published_at
        FROM template_versions;
        DROP TABLE template_versions;
        ALTER TABLE template_versions_v4 RENAME TO template_versions;
      `);
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
  }

}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Expected JSON text from Runtime Store.");
  return JSON.parse(value) as T;
}
