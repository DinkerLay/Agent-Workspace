import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { EMPTY_TEMPLATE_ASSET_MANIFEST_HASH, hashDefinition } from "@agent-workspace/runtime-contracts";

export type SqliteRuntimeStoreOptions = {
  path: string;
  now?: () => string;
};

/**
 * The Runtime Host owns this connection. Repositories receive this narrow store
 * capability instead of a raw DatabaseSync instance.
 */
export class SqliteRuntimeStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;
  #transactionDepth = 0;

  constructor({ path, now = () => new Date().toISOString() }: SqliteRuntimeStoreOptions) {
    this.#database = new DatabaseSync(path);
    this.#now = now;
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
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

      CREATE TABLE IF NOT EXISTS logical_sessions (
        logical_session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        agent_card_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        execution_profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, agent_card_id)
      );

      CREATE TABLE IF NOT EXISTS provider_session_bindings (
        binding_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        execution_profile_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_host_id TEXT,
        native_binding_ref TEXT,
        binding_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        recoverable INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_facts (
        provider_fact_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES provider_session_bindings(binding_id),
        provider_id TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        fact_type TEXT NOT NULL,
        fact_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(binding_id, dedup_key)
      );

      CREATE TABLE IF NOT EXISTS async_operations (
        async_operation_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES provider_session_bindings(binding_id),
        invocation_id TEXT REFERENCES invocations(invocation_id),
        native_operation_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attentions (
        attention_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        binding_id TEXT NOT NULL REFERENCES provider_session_bindings(binding_id),
        binding_revision INTEGER NOT NULL,
        native_request_id TEXT NOT NULL,
        active_input_submission_id TEXT,
        active_invocation_id TEXT,
        request_json TEXT NOT NULL,
        response_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(binding_id, binding_revision, native_request_id)
      );

      CREATE TABLE IF NOT EXISTS outbox (
        outbox_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        binding_id TEXT REFERENCES provider_session_bindings(binding_id),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until TEXT,
        last_effect_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(command_id, kind)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        workspace_relative_path TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        source_invocation_id TEXT REFERENCES invocations(invocation_id),
        source_provider_fact_id TEXT,
        source_message_id TEXT REFERENCES session_messages(message_id),
        evidence_reference_ids_json TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        UNIQUE(source_message_id, workspace_relative_path)
      );

      /**
       * This durable intent is a deletion fence, not a user-visible lifecycle
       * state. It is written before any Host filesystem effect, and prevents a
       * second command from changing the retained Task while deletion recovers.
       */
      CREATE TABLE IF NOT EXISTS task_permanent_delete_intents (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
        expected_revision INTEGER NOT NULL,
        artifact_ids_json TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        prepared_at TEXT NOT NULL
      );

      /** Survives Task-row removal so a crash before command receipt can retry safely. */
      CREATE TABLE IF NOT EXISTS task_permanent_delete_tombstones (
        command_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS presentation_leases (
        presentation_lease_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES provider_session_bindings(binding_id),
        descriptor_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_events (
        event_id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_commands (
        command_id TEXT PRIMARY KEY,
        command_type TEXT NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_hosts (
        provider_host_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        workspace_id TEXT,
        cwd TEXT,
        protocol_fingerprint TEXT,
        provider_version TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evidence_references (
        evidence_reference_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        locator TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS outbox_ready_idx ON outbox(state, lease_until, created_at);
      CREATE INDEX IF NOT EXISTS provider_facts_binding_idx ON provider_facts(binding_id, received_at);
      CREATE INDEX IF NOT EXISTS runtime_events_topic_idx ON runtime_events(topic, created_at);
      CREATE INDEX IF NOT EXISTS template_assets_version_idx ON template_assets(template_version_id, asset_path);
      CREATE INDEX IF NOT EXISTS task_permanent_delete_tombstones_task_idx ON task_permanent_delete_tombstones(task_id, deleted_at);
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

      CREATE TRIGGER IF NOT EXISTS task_update_rejected_while_permanent_delete_pending
      BEFORE UPDATE ON tasks
      WHEN EXISTS (
        SELECT 1 FROM task_permanent_delete_intents intent WHERE intent.task_id = OLD.task_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'task_permanent_delete_in_progress');
      END;
    `);
    this.#createMessageKernelTables();
    this.#rebuildSessionMessagesWithoutInvocationForeignKey();
    this.#migrateLegacyExecutionGraphToMessageKernel();
    this.#migrateMessageKernelV9();
    this.#createMessageKernelIndexes();

    // These columns repair only an interrupted pre-release Runtime schema. This
    // is not an import or compatibility bridge for the removed legacy Runtime.
    this.#ensureColumn("attentions", "updated_at", "TEXT");
    this.#ensureColumn("tasks", "achievement_json", "TEXT");
    this.#ensureColumn("tasks", "trashed_at", "TEXT");
    this.#ensureColumn("template_versions", "asset_manifest_hash", `TEXT NOT NULL DEFAULT '${EMPTY_TEMPLATE_ASSET_MANIFEST_HASH}'`);
    this.#ensureColumn("task_architecture_snapshots", "task_input_values_json", "TEXT NOT NULL DEFAULT '[]'");
    this.#ensureColumn("task_architecture_snapshots", "task_goal_content", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("task_architecture_snapshots", "task_goal_content_digest", "TEXT NOT NULL DEFAULT ''");
    this.#ensureColumn("task_architecture_snapshots", "task_goal_compiler_version", "TEXT NOT NULL DEFAULT 'task-goal/v1'");
    this.#ensureColumn("session_messages", "task_goal_compiler_version", "TEXT");
    this.#ensureColumn("artifacts", "source_message_id", "TEXT REFERENCES session_messages(message_id)");
    this.#rebuildArtifactsForCanonicalClaims();
    this.#rebuildTemplateVersionsForAssetManifest();
    this.run("UPDATE attentions SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''");
    this.run(
      "UPDATE template_versions SET asset_manifest_hash = ? WHERE asset_manifest_hash IS NULL OR asset_manifest_hash = ''",
      EMPTY_TEMPLATE_ASSET_MANIFEST_HASH,
    );
    this.#backfillTaskGoalSnapshots();
    this.run(
      "INSERT OR REPLACE INTO runtime_meta(key, value) VALUES (?, ?)",
      "schema_version",
      "12",
    );
  }

  #backfillTaskGoalSnapshots(): void {
    const rows = this.#database.prepare(
      `SELECT snapshot.architecture_snapshot_id, task.title, task.goal
       FROM task_architecture_snapshots snapshot
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

  /**
   * The message kernel is deliberately independent of Provider-native state.
   * A message is the immutable collaboration payload; an inbox row is the
   * durable routing intent; InputSubmission is the later Provider delivery.
   * The two cross-references between inbox and input are populated in separate
   * writes so neither side is ever an optimistic delivery claim.
   */
  #createMessageKernelTables(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        source_logical_session_id TEXT REFERENCES logical_sessions(logical_session_id),
        source_session_turn_id TEXT,
        source_human_intervention_id TEXT,
        -- Assignment Messages are created before their Invocation row so the
        -- parent/child relationship is intentionally domain-validated rather
        -- than an immediate SQLite foreign key.
        invocation_id TEXT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        task_goal_compiler_version TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relay_blocks (
        relay_block_id TEXT PRIMARY KEY,
        source_message_id TEXT NOT NULL REFERENCES session_messages(message_id),
        ordinal INTEGER NOT NULL,
        suggested_target_agent_card_ids_json TEXT NOT NULL,
        suggested_audience TEXT,
        topic TEXT,
        format TEXT NOT NULL,
        content TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        parser_version INTEGER NOT NULL,
        source_start INTEGER NOT NULL,
        source_end INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_message_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS input_submissions (
        input_submission_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        binding_id TEXT NOT NULL REFERENCES provider_session_bindings(binding_id),
        source_inbox_item_id TEXT NOT NULL REFERENCES session_inbox_items(inbox_item_id),
        content_message_id TEXT NOT NULL REFERENCES session_messages(message_id),
        delivery_role TEXT NOT NULL,
        command_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        content_digest TEXT NOT NULL,
        content TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        provider_effect_id TEXT,
        native_message_id TEXT,
        native_turn_id TEXT,
        evidence_reference_id TEXT,
        supersedes_input_submission_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_inbox_items (
        inbox_item_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        target_logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        rendered_message_id TEXT NOT NULL REFERENCES session_messages(message_id),
        forward_id TEXT REFERENCES message_forwards(forward_id),
        human_intervention_id TEXT REFERENCES human_interventions(human_intervention_id),
        reply_to_logical_session_id TEXT REFERENCES logical_sessions(logical_session_id),
        state TEXT NOT NULL,
        lease_id TEXT,
        lease_expires_at TEXT,
        delivery_input_submission_id TEXT REFERENCES input_submissions(input_submission_id),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(target_logical_session_id, rendered_message_id)
      );

      CREATE TABLE IF NOT EXISTS message_forward_batches (
        publish_batch_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        expected_task_revision INTEGER NOT NULL,
        fanout_key TEXT NOT NULL,
        decided_by_logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        decided_by_session_turn_id TEXT NOT NULL,
        target_logical_session_ids_json TEXT NOT NULL,
        selection_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, idempotency_key),
        UNIQUE(task_id, run_id, fanout_key)
      );

      CREATE TABLE IF NOT EXISTS message_forwards (
        forward_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        expected_task_revision INTEGER NOT NULL,
        publish_batch_id TEXT REFERENCES message_forward_batches(publish_batch_id),
        target_idempotency_key TEXT NOT NULL,
        decided_by_logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        decided_by_session_turn_id TEXT NOT NULL,
        target_logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        mode TEXT NOT NULL,
        rendered_message_id TEXT NOT NULL REFERENCES session_messages(message_id),
        created_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, idempotency_key, target_logical_session_id),
        UNIQUE(publish_batch_id, target_logical_session_id)
      );

      CREATE TABLE IF NOT EXISTS message_forward_selections (
        forward_selection_id TEXT PRIMARY KEY,
        forward_id TEXT NOT NULL REFERENCES message_forwards(forward_id),
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL,
        source_message_id TEXT NOT NULL REFERENCES session_messages(message_id),
        relay_block_id TEXT REFERENCES relay_blocks(relay_block_id),
        content_digest TEXT NOT NULL,
        UNIQUE(forward_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS human_interventions (
        human_intervention_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        expected_task_revision INTEGER NOT NULL,
        target_logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        content TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        affected_session_turn_id TEXT,
        affected_invocation_id TEXT REFERENCES invocations(invocation_id),
        mode TEXT NOT NULL,
        card_message_id TEXT REFERENCES session_messages(message_id),
        conductor_mirror_message_id TEXT REFERENCES session_messages(message_id),
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, run_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS session_turns (
        session_turn_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        input_submission_id TEXT NOT NULL UNIQUE REFERENCES input_submissions(input_submission_id),
        target_logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        kind TEXT NOT NULL,
        initiator TEXT NOT NULL,
        trigger TEXT NOT NULL,
        reply_to_logical_session_id TEXT REFERENCES logical_sessions(logical_session_id),
        invocation_id TEXT REFERENCES invocations(invocation_id),
        human_intervention_id TEXT REFERENCES human_interventions(human_intervention_id),
        affected_session_turn_id TEXT,
        final_message_id TEXT REFERENCES session_messages(message_id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invocations (
        invocation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        target_logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        target_agent_card_id TEXT NOT NULL,
        binding_id TEXT NOT NULL REFERENCES provider_session_bindings(binding_id),
        reply_to_logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
        assignment_message_id TEXT NOT NULL REFERENCES session_messages(message_id),
        final_message_id TEXT REFERENCES session_messages(message_id),
        status TEXT NOT NULL,
        instruction TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        requested_artifacts_json TEXT NOT NULL,
        priority TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

    `);
  }

  #createMessageKernelIndexes(): void {
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS session_messages_run_idx ON session_messages(run_id, created_at, message_id);
      CREATE INDEX IF NOT EXISTS session_messages_source_session_idx ON session_messages(source_logical_session_id, created_at, message_id);
      CREATE INDEX IF NOT EXISTS session_messages_source_turn_idx ON session_messages(source_session_turn_id, created_at, message_id);
      CREATE INDEX IF NOT EXISTS session_messages_invocation_idx ON session_messages(invocation_id, created_at, message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS session_messages_one_final_per_invocation_idx
        ON session_messages(invocation_id) WHERE invocation_id IS NOT NULL AND kind = 'agent_final';
      CREATE INDEX IF NOT EXISTS relay_blocks_source_idx ON relay_blocks(source_message_id, ordinal);
      CREATE INDEX IF NOT EXISTS relay_blocks_topic_idx ON relay_blocks(topic, created_at, relay_block_id);
      CREATE INDEX IF NOT EXISTS message_forwards_run_idx ON message_forwards(run_id, created_at, forward_id);
      CREATE INDEX IF NOT EXISTS message_forward_selections_order_idx ON message_forward_selections(forward_id, ordinal);
      CREATE INDEX IF NOT EXISTS human_interventions_run_idx ON human_interventions(run_id, created_at, human_intervention_id);
      CREATE INDEX IF NOT EXISTS session_inbox_target_state_idx ON session_inbox_items(target_logical_session_id, state, created_at, inbox_item_id);
      CREATE INDEX IF NOT EXISTS session_inbox_run_idx ON session_inbox_items(run_id, created_at, inbox_item_id);
      CREATE INDEX IF NOT EXISTS input_submissions_inbox_idx ON input_submissions(source_inbox_item_id, created_at);
      CREATE INDEX IF NOT EXISTS invocations_reply_idx ON invocations(reply_to_logical_session_id, created_at, invocation_id);
      CREATE INDEX IF NOT EXISTS invocations_final_message_idx ON invocations(final_message_id);
      CREATE INDEX IF NOT EXISTS session_turns_target_status_idx ON session_turns(target_logical_session_id, status, created_at);
    `);
  }

  /**
   * The first v7 draft made `session_messages.invocation_id` an immediate FK.
   * That makes a canonical assignment impossible: its Message must contain the
   * Invocation ID before the Invocation can reference that Message. Rebuild
   * only this table, preserving all Message IDs and child references.
   */
  #rebuildSessionMessagesWithoutInvocationForeignKey(): void {
    if (!this.#tableHasForeignKey("session_messages", "invocation_id", "invocations")) return;
    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.#database.exec(`
        CREATE TABLE session_messages_v8 (
          message_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          run_id TEXT NOT NULL REFERENCES task_runs(run_id),
          source_logical_session_id TEXT REFERENCES logical_sessions(logical_session_id),
          invocation_id TEXT,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          content_digest TEXT NOT NULL,
          origin_message_id TEXT REFERENCES session_messages_v8(message_id),
          origin_relay_block_id TEXT REFERENCES relay_blocks(relay_block_id),
          relayed_by_logical_session_id TEXT REFERENCES logical_sessions(logical_session_id),
          created_at TEXT NOT NULL
        );
        INSERT INTO session_messages_v8(message_id, task_id, run_id, source_logical_session_id, invocation_id, kind, content, content_digest, origin_message_id, origin_relay_block_id, relayed_by_logical_session_id, created_at)
        SELECT message_id, task_id, run_id, source_logical_session_id, invocation_id, kind, content, content_digest, origin_message_id, origin_relay_block_id, relayed_by_logical_session_id, created_at
        FROM session_messages;
        DROP TABLE session_messages;
        ALTER TABLE session_messages_v8 RENAME TO session_messages;
      `);
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
    const violation = this.#database.prepare("PRAGMA foreign_key_check").get() as { table?: unknown } | undefined;
    if (violation) throw new Error(`runtime_store_session_message_rebuild_fk_violation:${String(violation.table ?? "unknown")}`);
  }

  /**
   * v6's `contextRefs -> invocation_results -> wakeups` graph cannot prove a
   * complete Agent final Message, so it must not be made to look like one.
   * This direct cut retains product definitions and Tasks, but clears stale
   * execution state and makes formerly active Tasks startable again.
   */
  #migrateLegacyExecutionGraphToMessageKernel(): void {
    const legacyExecutionGraph = this.#tableExists("invocation_results")
      || this.#tableExists("wakeups")
      || this.#tableHasColumn("invocations", "context_refs_json")
      || this.#tableHasColumn("input_submissions", "source_inbox_item_id") === false;
    if (!legacyExecutionGraph) return;

    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      const now = this.now();
      const abandonedRunIds = this.#database.prepare(
        `SELECT run_id FROM task_runs
         WHERE status IN ('starting', 'running', 'waiting_attention', 'stopping', 'cancellation_unknown')`,
      ).all() as readonly { run_id?: unknown }[];
      const runIds = abandonedRunIds
        .map((row) => row.run_id)
        .filter((value): value is string => typeof value === "string");
      if (runIds.length > 0) {
        const placeholders = runIds.map(() => "?").join(",");
        this.run(
          `UPDATE task_runs
           SET status = 'failed', ended_at = COALESCE(ended_at, ?), revision = revision + 1
           WHERE run_id IN (${placeholders})`,
          now,
          ...runIds,
        );
        this.run(
          `UPDATE logical_sessions
           SET status = CASE
             WHEN status IN ('active', 'waiting_attention', 'idle') THEN 'unrecoverable'
             ELSE status
           END,
           updated_at = ?
           WHERE run_id IN (${placeholders})`,
          now,
          ...runIds,
        );
        this.run(
          `UPDATE tasks
           SET active_run_id = NULL, status = 'queued', revision = revision + 1, updated_at = ?
           WHERE active_run_id IN (${placeholders})`,
          now,
          ...runIds,
        );
      }
      // Keep ArtifactReference and historical TaskRun identity, but remove an
      // unsafe source link rather than fabricating an agent-final Message.
      this.run("UPDATE artifacts SET source_invocation_id = NULL WHERE source_invocation_id IS NOT NULL");

      this.#database.exec(`
        DELETE FROM presentation_leases;
        DELETE FROM outbox;
        DELETE FROM provider_facts;
        DELETE FROM async_operations;
        DELETE FROM attentions;
        DELETE FROM runtime_events;
        DELETE FROM runtime_commands;
        DELETE FROM provider_hosts;
        DELETE FROM provider_session_bindings;
      `);
      // Invocations and Inputs are table-rebuilt below. Dropping, rather than
      // preserving nullable aliases, enforces a single canonical write path.
      this.#database.exec("DROP TABLE IF EXISTS invocation_results");
      this.#database.exec("DROP TABLE IF EXISTS wakeups");
      this.#database.exec("DROP TABLE IF EXISTS invocations");
      this.#database.exec("DROP TABLE IF EXISTS input_submissions");
      this.#createMessageKernelTables();
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
    const violation = this.#database.prepare("PRAGMA foreign_key_check").get() as { table?: unknown } | undefined;
    if (violation) throw new Error(`runtime_store_message_kernel_migration_fk_violation:${String(violation.table ?? "unknown")}`);
  }

  /**
   * v9 is a direct cut from visibility/shared-relay routing to explicit
   * Forward/Intervention/Turn ownership. Old active execution state cannot be
   * proven under the new model, so it is failed rather than aliased or replayed.
   */
  #migrateMessageKernelV9(): void {
    const legacyKernel = this.#tableHasColumn("relay_blocks", "visibility")
      || this.#tableHasColumn("session_inbox_items", "source_message_id")
      || this.#tableHasColumn("input_submissions", "content_message_id") === false;
    if (!legacyKernel) return;
    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      const now = this.now();
      const activeRows = this.#database.prepare(
        `SELECT run_id FROM task_runs
         WHERE status IN ('starting', 'running', 'waiting_attention', 'stopping', 'cancellation_unknown')`,
      ).all() as readonly { run_id?: unknown }[];
      const runIds = activeRows.map((row) => row.run_id).filter((value): value is string => typeof value === "string");
      if (runIds.length > 0) {
        const placeholders = runIds.map(() => "?").join(",");
        this.run(
          `UPDATE task_runs SET status = 'failed', ended_at = COALESCE(ended_at, ?), revision = revision + 1
           WHERE run_id IN (${placeholders})`,
          now,
          ...runIds,
        );
        this.run(
          `UPDATE logical_sessions SET status = 'unrecoverable', updated_at = ?
           WHERE run_id IN (${placeholders}) AND status IN ('unmaterialized', 'active', 'waiting_attention', 'idle')`,
          now,
          ...runIds,
        );
        this.run(
          `UPDATE tasks SET active_run_id = NULL, status = 'queued', revision = revision + 1, updated_at = ?
           WHERE active_run_id IN (${placeholders})`,
          now,
          ...runIds,
        );
      }
      this.run("UPDATE artifacts SET source_invocation_id = NULL WHERE source_invocation_id IS NOT NULL");
      this.#database.exec(`
        DELETE FROM presentation_leases;
        DELETE FROM outbox;
        DELETE FROM provider_facts;
        DELETE FROM async_operations;
        DELETE FROM attentions;
        DELETE FROM runtime_events;
        DELETE FROM runtime_commands;
        DELETE FROM provider_hosts;
        DELETE FROM provider_session_bindings;
        DROP TABLE IF EXISTS message_forward_selections;
        DROP TABLE IF EXISTS message_forwards;
        DROP TABLE IF EXISTS message_forward_batches;
        DROP TABLE IF EXISTS session_turns;
        DROP TABLE IF EXISTS human_interventions;
        DROP TABLE IF EXISTS invocations;
        DROP TABLE IF EXISTS input_submissions;
        DROP TABLE IF EXISTS session_inbox_items;
        DROP TABLE IF EXISTS relay_blocks;
        DROP TABLE IF EXISTS session_messages;
      `);
      this.#createMessageKernelTables();
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
    const violation = this.#database.prepare("PRAGMA foreign_key_check").get() as { table?: unknown } | undefined;
    if (violation) throw new Error(`runtime_store_message_kernel_v9_fk_violation:${String(violation.table ?? "unknown")}`);
  }

  #tableExists(table: string): boolean {
    return this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  }

  #tableHasColumn(table: string, column: string): boolean {
    if (!this.#tableExists(table)) return false;
    return (this.#database.prepare(`PRAGMA table_info(${table})`).all() as readonly { name?: unknown }[])
      .some((entry) => entry.name === column);
  }

  #tableHasForeignKey(table: string, column: string, targetTable: string): boolean {
    if (!this.#tableExists(table)) return false;
    return (this.#database.prepare(`PRAGMA foreign_key_list(${table})`).all() as readonly { from?: unknown; table?: unknown }[])
      .some((entry) => entry.from === column && entry.table === targetTable);
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

  /**
   * v11 keys an Artifact claim to the canonical final Message and requested
   * path. Identical bytes at the same path in another Run remain distinct.
   */
  #rebuildArtifactsForCanonicalClaims(): void {
    const legacyIndex = (this.#database.prepare("PRAGMA index_list('artifacts')").all() as readonly { name?: unknown; unique?: unknown }[])
      .find((index) => {
        if (index.unique !== 1 || typeof index.name !== "string") return false;
        const quoted = index.name.replace(/"/g, '""');
        const fields = this.#database.prepare(`PRAGMA index_info("${quoted}")`).all() as readonly { name?: unknown; seqno?: unknown }[];
        return fields
          .slice()
          .sort((left, right) => Number(left.seqno) - Number(right.seqno))
          .map((field) => field.name)
          .join(",") === "task_id,workspace_relative_path,content_digest";
      });
    if (!legacyIndex) return;
    this.#database.exec("PRAGMA foreign_keys = OFF");
    try {
      this.#database.exec(`
        CREATE TABLE artifacts_v11 (
          artifact_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id),
          run_id TEXT NOT NULL REFERENCES task_runs(run_id),
          workspace_relative_path TEXT NOT NULL,
          content_digest TEXT NOT NULL,
          source_invocation_id TEXT REFERENCES invocations(invocation_id),
          source_provider_fact_id TEXT,
          source_message_id TEXT REFERENCES session_messages(message_id),
          evidence_reference_ids_json TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          UNIQUE(source_message_id, workspace_relative_path)
        );
        INSERT INTO artifacts_v11(
          artifact_id, task_id, run_id, workspace_relative_path, content_digest,
          source_invocation_id, source_provider_fact_id, source_message_id,
          evidence_reference_ids_json, verified_at
        )
        SELECT artifact_id, task_id, run_id, workspace_relative_path, content_digest,
          source_invocation_id, source_provider_fact_id, source_message_id,
          evidence_reference_ids_json, verified_at
        FROM artifacts;
        DROP TABLE artifacts;
        ALTER TABLE artifacts_v11 RENAME TO artifacts;
      `);
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON");
    }
    const violation = this.#database.prepare("PRAGMA foreign_key_check").get() as { table?: unknown } | undefined;
    if (violation) throw new Error(`runtime_store_artifact_v11_fk_violation:${String(violation.table ?? "unknown")}`);
  }
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("Expected JSON text from Runtime Store.");
  return JSON.parse(value) as T;
}
