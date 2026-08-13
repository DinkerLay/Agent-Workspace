import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_TEMPLATE_ASSET_MANIFEST_HASH } from "@agent-workspace/runtime-contracts";
import {
  SqliteRuntimeStore,
  SUPERSEDED_PROTOCOL_META_KEY,
  SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST,
} from "./sqlite.js";

const paths: string[] = [];

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("SqliteRuntimeStore", () => {
  it("creates only current shared and Session-ID tables on a fresh database", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-store-fresh-"));
    paths.push(directory);
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });

    expect(store.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("21");
    expect(JSON.parse(store.one<{ value: string }>(
      "SELECT value FROM runtime_meta WHERE key = ?",
      SUPERSEDED_PROTOCOL_META_KEY,
    )!.value)).toEqual([]);

    const tables = new Set(store.many<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => row.name));
    for (const table of SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST) expect(tables.has(table)).toBe(false);
    for (const table of [
      "templates",
      "template_versions",
      "workspace_authorizations",
      "task_setup_drafts",
      "meta_sessions",
      "meta_turns",
      "tasks",
      "task_runs",
      "runtime_commands",
      "session_id_logical_sessions",
      "session_id_session_messages",
      "session_id_session_turns",
      "session_id_provider_effect_outbox",
    ]) expect(tables.has(table)).toBe(true);

    expect(() => store.transaction(() => {
      store.run(
        "INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "template-rollback", "rollback", "Rollback", "active", 1, store.now(), store.now(),
      );
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.one("SELECT template_id FROM templates WHERE template_id = ?", "template-rollback")).toBeUndefined();
    store.close();
  });

  it("marks allowlisted superseded table names and authorizes no access to their rows", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-store-upgrade-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE task_architecture_snapshots (
        architecture_snapshot_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        task_goal_content TEXT NOT NULL,
        task_goal_content_digest TEXT NOT NULL,
        task_goal_compiler_version TEXT NOT NULL,
        definition_json TEXT NOT NULL
      );
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL
      );
      INSERT INTO task_architecture_snapshots VALUES (
        'legacy-snapshot', 'legacy-task', '', '', 'legacy-compiler', ' { "legacy": true } '
      );
      INSERT INTO tasks VALUES ('legacy-task', 'Legacy title', 'Legacy goal');
    `);
    for (const [index, table] of SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST.entries()) {
      legacy.exec(`CREATE TABLE "${table}" (legacy_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
      legacy.prepare(`INSERT INTO "${table}"(legacy_id, payload) VALUES (?, ?)`)
        .run(`legacy-${index}`, `payload-${table}`);
    }
    legacy.exec("CREATE TABLE operator_private_table (legacy_id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    legacy.prepare("INSERT INTO operator_private_table(legacy_id, payload) VALUES (?, ?)")
      .run("private-1", "keep-private");
    const definitions = new Map(
      (legacy.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as unknown as readonly { name: string; sql: string }[])
        .map((row) => [row.name, row.sql] as const),
    );
    legacy.close();

    const upgraded = new SqliteRuntimeStore({ path: databasePath });
    expect(JSON.parse(upgraded.one<{ value: string }>(
      "SELECT value FROM runtime_meta WHERE key = ?",
      SUPERSEDED_PROTOCOL_META_KEY,
    )!.value)).toEqual([...SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST]);
    for (const table of SUPERSEDED_PROTOCOL_TABLE_ALLOWLIST) {
      expect(upgraded.one<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table,
      )?.sql).toBe(definitions.get(table));
      expect(() => upgraded.one(`SELECT legacy_id, payload FROM "${table}"`))
        .toThrow(/prohibited|not authorized/iu);
      expect(() => upgraded.run(`UPDATE "${table}" SET payload = payload`))
        .toThrow(/prohibited|not authorized/iu);
    }
    expect(upgraded.one<{ legacy_id: string; payload: string }>(
      "SELECT legacy_id, payload FROM operator_private_table",
    )).toEqual({ legacy_id: "private-1", payload: "keep-private" });
    expect(upgraded.one<{
      definition_json: string;
      task_goal_content: string;
      task_goal_content_digest: string;
      task_goal_compiler_version: string;
    }>(
      `SELECT definition_json, task_goal_content, task_goal_content_digest, task_goal_compiler_version
       FROM task_architecture_snapshots WHERE architecture_snapshot_id = ?`,
      "legacy-snapshot",
    )).toEqual({
      definition_json: ' { "legacy": true } ',
      task_goal_content: "",
      task_goal_content_digest: "",
      task_goal_compiler_version: "legacy-compiler",
    });
    expect(upgraded.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("21");
    upgraded.close();
  });

  it("upgrades current control state without reading or rewriting retained pre-cutover direct rows", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-stop-v17-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const fresh = new SqliteRuntimeStore({ path: databasePath });
    const now = "2026-08-11T00:00:00.000Z";
    fresh.run(
      "INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "template_stop_v17", "stop-v17", "Stop v17", "active", 1, now, now,
    );
    fresh.run(
      `INSERT INTO template_versions(
         template_version_id, template_id, version, schema_version, definition_json,
         definition_hash, asset_manifest_hash, created_at, published_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "template_version_stop_v17", "template_stop_v17", 1, 2, "{}", "fnv1a64:stop-v17",
      EMPTY_TEMPLATE_ASSET_MANIFEST_HASH, now, now,
    );
    fresh.run(
      `INSERT INTO task_architecture_snapshots(
         architecture_snapshot_id, task_id, template_id, template_version_id,
         template_definition_hash, definition_json, workspace_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "architecture_stop_v17", "task_stop_v17", "template_stop_v17", "template_version_stop_v17",
      "fnv1a64:stop-v17", "{}", "{\"workspaceId\":\"workspace_stop_v17\",\"cwd\":\"/tmp\"}", now,
    );
    fresh.run(
      `INSERT INTO tasks(
         task_id, architecture_snapshot_id, title, goal, status, active_run_id, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "task_stop_v17", "architecture_stop_v17", "Stop v17", "Preserve existing rows.",
      "running", "run_stop_v17", 1, now, now,
    );
    fresh.run(
      `INSERT INTO task_runs(
         run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "run_stop_v17", "task_stop_v17", "session_stop_v17", "running", 1, 1, now,
    );
    fresh.run(
      `INSERT INTO session_id_session_control_audits(
         session_control_audit_id, task_id, run_id, session_id, command_id, idempotency_key,
         kind, state, affected_inbox_item_ids_json, requested_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "control_stop_v17", "task_stop_v17", "run_stop_v17", "session_stop_v17",
      "command_stop_v17", "interrupt:stop-v17", "human_interrupt", "requested", "[]", now,
    );
    fresh.run(
      `INSERT INTO session_id_provider_effect_outbox(
         outbox_id, task_id, run_id, session_id, session_control_audit_id, kind,
         idempotency_key, payload_json, payload_fingerprint, state, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "effect_stop_v17", "task_stop_v17", "run_stop_v17", "session_stop_v17", "control_stop_v17",
      "request_interrupt", "interrupt:stop-v17", ' { "rawNativeRequestId": "never-read-or-migrated" } ',
      "fnv1a64:stop-v17", "pending", 0, now, now,
    );
    fresh.run(
      `INSERT INTO session_id_provider_bindings(
         binding_id, task_id, run_id, session_id, agent_card_id, execution_profile_id,
         provider, provider_host_id, native_binding_ref, status, recoverable,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "binding_stop_v17", "task_stop_v17", "run_stop_v17", "session_stop_v17",
      "agent_card_stop_v17", "profile_stop_v17", "opencode", "host_stop_v17",
      "raw-native-binding-ref-never-read-or-migrated", "unrecoverable", 0, 1, now, now,
    );
    fresh.run(
      `INSERT INTO session_id_provider_facts(
         provider_fact_id, binding_id, binding_revision, provider, kind, dedup_key,
         fact_fingerprint, deduplication_json, correlation_json, evidence_reference_id,
         payload_json, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "provider_fact_stop_v17", "binding_stop_v17", 1, "opencode", "diagnostic",
      "dedup-stop-v17", "sha256:fact-stop-v17", "{}", "{}", null,
      ' { "rawProviderEvent": "never-read-or-migrated" } ', now,
    );
    fresh.close();

    const v17 = new DatabaseSync(databasePath);
    v17.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE session_id_provider_bindings RENAME TO session_id_provider_bindings_v17_source;
      ALTER TABLE session_id_provider_effect_outbox RENAME TO session_id_provider_effect_outbox_v18_source;
      ALTER TABLE session_id_session_control_audits RENAME TO session_id_session_control_audits_v18_source;
      CREATE TABLE session_id_provider_bindings (
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
          'unbound', 'binding_effect_accepted', 'active', 'recovering', 'unrecoverable'
        )),
        recoverable INTEGER NOT NULL CHECK (recoverable IN (0, 1)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(binding_id, revision)
      );
      INSERT INTO session_id_provider_bindings SELECT * FROM session_id_provider_bindings_v17_source;
      CREATE TABLE session_id_session_control_audits (
        session_control_audit_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('conductor_interrupt', 'human_interrupt', 'close')),
        state TEXT NOT NULL CHECK (state IN ('requested', 'accepted', 'confirmed', 'unknown', 'rejected', 'closed')),
        affected_inbox_item_ids_json TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        settled_at TEXT,
        reason TEXT,
        UNIQUE(task_id, run_id, idempotency_key)
      );
      INSERT INTO session_id_session_control_audits SELECT * FROM session_id_session_control_audits_v18_source;
      CREATE TABLE session_id_provider_effect_outbox (
        outbox_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        session_id TEXT NOT NULL REFERENCES session_id_logical_sessions(session_id),
        session_turn_id TEXT,
        session_control_audit_id TEXT REFERENCES session_id_session_control_audits(session_control_audit_id),
        kind TEXT NOT NULL CHECK (kind IN ('ensure_binding', 'submit_delivery', 'request_interrupt')),
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
        UNIQUE(task_id, run_id, idempotency_key),
        CHECK (state <> 'leased' OR lease_until IS NOT NULL),
        CHECK (state <> 'suppressed' OR reason IS NOT NULL)
      );
      INSERT INTO session_id_provider_effect_outbox(
        outbox_id, task_id, run_id, session_id, session_turn_id,
        session_control_audit_id, kind, idempotency_key, payload_json,
        payload_fingerprint, state, attempts, lease_until, receipt_json,
        reason, created_at, updated_at
      ) SELECT
        outbox_id, task_id, run_id, session_id, session_turn_id,
        session_control_audit_id, kind, idempotency_key, payload_json,
        payload_fingerprint, state, attempts, lease_until, receipt_json,
        reason, created_at, updated_at
      FROM session_id_provider_effect_outbox_v18_source;
      DROP TABLE session_id_provider_bindings_v17_source;
      DROP TABLE session_id_provider_effect_outbox_v18_source;
      DROP TABLE session_id_session_control_audits_v18_source;
      CREATE TABLE operator_private_v17_bytes (note_id TEXT PRIMARY KEY, payload BLOB NOT NULL);
      INSERT INTO operator_private_v17_bytes VALUES ('note-v17', x'0001FEFF');
      UPDATE runtime_meta SET value = '14' WHERE key = 'schema_version';
      PRAGMA foreign_keys = ON;
    `);
    const retainedDefinitions = new Map(
      (v17.prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'session_id_provider_bindings', 'session_id_provider_facts',
           'session_id_attentions', 'session_id_provider_effect_outbox',
           'operator_private_v17_bytes'
         ) ORDER BY name`,
      ).all() as unknown as readonly { name: string; sql: string }[])
        .map((row) => [row.name, row.sql] as const),
    );
    v17.close();

    const migrated = new SqliteRuntimeStore({ path: databasePath });
    expect(migrated.one<{ kind: string }>(
      "SELECT kind FROM session_id_session_control_audits WHERE session_control_audit_id = ?", "control_stop_v17",
    )).toEqual({ kind: "human_interrupt" });
    expect(migrated.one<{ kind: string; state: string }>(
      "SELECT kind, state FROM session_id_provider_effect_outbox WHERE outbox_id = ?", "effect_stop_v17",
    )).toEqual({ kind: "request_interrupt", state: "pending" });
    expect(migrated.one<{ native_binding_ref: string }>(
      "SELECT native_binding_ref FROM session_id_provider_bindings WHERE binding_id = ?", "binding_stop_v17",
    )).toEqual({ native_binding_ref: "raw-native-binding-ref-never-read-or-migrated" });
    expect(migrated.one<{ payload_json: string }>(
      "SELECT payload_json FROM session_id_provider_effect_outbox WHERE outbox_id = ?", "effect_stop_v17",
    )).toEqual({ payload_json: ' { "rawNativeRequestId": "never-read-or-migrated" } ' });
    expect(migrated.one<{ payload_json: string }>(
      "SELECT payload_json FROM session_id_provider_facts WHERE provider_fact_id = ?", "provider_fact_stop_v17",
    )).toEqual({ payload_json: ' { "rawProviderEvent": "never-read-or-migrated" } ' });
    for (const [table, sql] of retainedDefinitions) {
      expect(migrated.one<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table,
      )?.sql).toBe(sql);
    }
    expect(new Uint8Array(migrated.one<{ payload: Uint8Array }>(
      "SELECT payload FROM operator_private_v17_bytes WHERE note_id = 'note-v17'",
    )!.payload)).toEqual(Uint8Array.from([0, 1, 254, 255]));
    expect(migrated.one<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_id_acp_v3_provider_effect_intents'",
    )?.name).toBe("session_id_acp_v3_provider_effect_intents");
    expect(() => migrated.run(
      `INSERT INTO session_id_session_control_audits(
         session_control_audit_id, task_id, run_id, session_id, command_id, idempotency_key,
         kind, state, affected_inbox_item_ids_json, requested_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "control_task_stop_v18", "task_stop_v17", "run_stop_v17", "session_stop_v17",
      "command_task_stop_v18", "task-stop:v18", "task_stop", "requested", "[]", now,
    )).not.toThrow();
    expect(() => migrated.run(
      `INSERT INTO session_id_provider_effect_outbox(
         outbox_id, task_id, run_id, session_id, kind, idempotency_key,
         payload_json, payload_fingerprint, state, attempts, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "effect_release_v18", "task_stop_v17", "run_stop_v17", "session_stop_v17", "release_binding",
      "release:v18", "{}", "fnv1a64:release-v18", "pending", 0, now, now,
    )).toThrow();
    migrated.close();
  });

  it("migrates v11 by adding the configuration-owned Meta turn queue and active-turn fence", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-meta-turn-v11-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    new SqliteRuntimeStore({ path: databasePath }).close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE meta_turns;
      DROP TABLE session_id_tasks;
      UPDATE runtime_meta SET value = '11' WHERE key = 'schema_version';
    `);
    legacy.close();

    const migrated = new SqliteRuntimeStore({ path: databasePath });
    expect(migrated.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("21");
    expect(migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "meta_turns")?.name)
      .toBe("meta_turns");
    expect(migrated.one<{ name: string; unique: number }>("SELECT name, \"unique\" FROM pragma_index_list('meta_turns') WHERE name = ?", "meta_turns_active_session_idx"))
      .toEqual({ name: "meta_turns_active_session_idx", unique: 1 });
    expect(migrated.one<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_id_tasks'",
    )?.name).toBe("session_id_tasks");
    expect(migrated.one<{ count: number }>("SELECT count(*) AS count FROM session_id_tasks")?.count).toBe(0);
    migrated.close();
  });

  it("upgrades v20 logical Sessions to typed v21 rows without rewriting v2 bytes or unknown tables", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-logical-v20-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const definitionBytes = ' { "schemaVersion": 2, "preserve": "exact-v2-bytes" } ';
    const now = "2026-08-12T00:00:00.000Z";
    const current = new SqliteRuntimeStore({ path: databasePath });
    current.run(
      "INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at) VALUES (?, ?, ?, 'active', 1, ?, ?)",
      "template_logical_v20", "logical-v20", "Logical v20", now, now,
    );
    current.run(
      `INSERT INTO template_versions(
         template_version_id, template_id, version, schema_version, definition_json,
         definition_hash, asset_manifest_hash, created_at, published_at
       ) VALUES (?, ?, 1, 2, ?, ?, ?, ?, ?)`,
      "template_version_logical_v20", "template_logical_v20", definitionBytes,
      "sha256:logical-v20", EMPTY_TEMPLATE_ASSET_MANIFEST_HASH, now, now,
    );
    current.run(
      `INSERT INTO task_architecture_snapshots(
         architecture_snapshot_id, task_id, template_id, template_version_id,
         template_definition_hash, definition_json, workspace_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      "architecture_logical_v20", "task_logical_v20", "template_logical_v20",
      "template_version_logical_v20", "sha256:logical-v20", definitionBytes,
      '{"workspaceId":"workspace_logical_v20","cwd":"/tmp/logical-v20"}', now,
    );
    current.run(
      `INSERT INTO tasks(
         task_id, architecture_snapshot_id, title, goal, status, active_run_id,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'running', ?, 1, ?, ?)`,
      "task_logical_v20", "architecture_logical_v20", "Logical v20", "Preserve row.",
      "run_logical_v20", now, now,
    );
    current.run(
      `INSERT INTO task_runs(
         run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at
       ) VALUES (?, ?, ?, 'running', 1, 1, ?)`,
      "run_logical_v20", "task_logical_v20", "logical_session_conductor_v20", now,
    );
    current.run(
      `INSERT INTO session_id_card_session_slots(
         card_session_slot_id, task_id, run_id, agent_card_id, current_session_id,
         latest_generation, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      "card_session_slot_logical_v20", "task_logical_v20", "run_logical_v20",
      "agent_card_logical_v20", "logical_session_card_v20", now, now,
    );
    current.run(
      `INSERT INTO session_id_logical_sessions(
         session_id, card_session_slot_id, task_id, run_id, session_kind,
         architecture_schema_version, agent_card_id, execution_profile_id,
         profile_revision_id, generation, lifecycle, created_at
       ) VALUES (?, ?, ?, ?, 'card', 2, ?, NULL, NULL, 1, 'current', ?)`,
      "logical_session_card_v20", "card_session_slot_logical_v20", "task_logical_v20",
      "run_logical_v20", "agent_card_logical_v20", now,
    );
    current.close();

    const v20 = new DatabaseSync(databasePath);
    v20.exec(`
      PRAGMA foreign_keys = OFF;
      PRAGMA legacy_alter_table = ON;
      ALTER TABLE session_id_logical_sessions RENAME TO session_id_logical_sessions_v21_source;
      CREATE TABLE session_id_logical_sessions (
        session_id TEXT PRIMARY KEY,
        card_session_slot_id TEXT NOT NULL REFERENCES session_id_card_session_slots(card_session_slot_id),
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        agent_card_id TEXT NOT NULL,
        execution_profile_id TEXT,
        generation INTEGER NOT NULL CHECK (generation > 0),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('current', 'closed', 'faulted')),
        created_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE(card_session_slot_id, generation),
        UNIQUE(session_id, run_id),
        CHECK ((lifecycle = 'current' AND closed_at IS NULL) OR lifecycle <> 'current')
      );
      INSERT INTO session_id_logical_sessions(
        session_id, card_session_slot_id, task_id, run_id, agent_card_id,
        execution_profile_id, generation, lifecycle, created_at, closed_at
      )
      SELECT session_id, card_session_slot_id, task_id, run_id, agent_card_id,
             execution_profile_id, generation, lifecycle, created_at, closed_at
      FROM session_id_logical_sessions_v21_source;
      DROP TABLE session_id_logical_sessions_v21_source;
      CREATE TABLE operator_private_v20 (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO operator_private_v20 VALUES ('private', 'preserve-private-bytes');
      UPDATE runtime_meta SET value = '20' WHERE key = 'schema_version';
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `);
    v20.close();

    const upgraded = new SqliteRuntimeStore({ path: databasePath });
    expect(upgraded.one<{ value: string }>(
      "SELECT value FROM runtime_meta WHERE key = 'schema_version'",
    )?.value).toBe("21");
    expect(upgraded.one<{ definition_json: string }>(
      "SELECT definition_json FROM template_versions WHERE template_version_id = ?",
      "template_version_logical_v20",
    )?.definition_json).toBe(definitionBytes);
    expect(upgraded.one<{ payload: string }>(
      "SELECT payload FROM operator_private_v20 WHERE key = 'private'",
    )?.payload).toBe("preserve-private-bytes");
    expect(upgraded.one<{
      session_kind: string;
      architecture_schema_version: number;
      card_session_slot_id: string;
      profile_revision_id: string | null;
    }>(
      `SELECT session_kind, architecture_schema_version, card_session_slot_id, profile_revision_id
       FROM session_id_logical_sessions WHERE session_id = ?`,
      "logical_session_card_v20",
    )).toEqual({
      session_kind: "card",
      architecture_schema_version: 2,
      card_session_slot_id: "card_session_slot_logical_v20",
      profile_revision_id: null,
    });
    expect(upgraded.many("PRAGMA foreign_key_check")).toEqual([]);
    expect(() => upgraded.run(
      `INSERT INTO session_id_logical_sessions(
         session_id, card_session_slot_id, task_id, run_id, session_kind,
         architecture_schema_version, agent_card_id, execution_profile_id,
         profile_revision_id, generation, lifecycle, created_at
       ) VALUES (?, NULL, ?, ?, 'card', 3, ?, ?, ?, 2, 'current', ?)`,
      "logical_session_card_without_slot", "task_logical_v20", "run_logical_v20",
      "agent_card_logical_v20", "profile_logical_v20", "profile_revision_logical_v20", now,
    )).toThrow(/CHECK constraint failed/iu);
    expect(() => upgraded.run(
      `INSERT INTO session_id_logical_sessions(
         session_id, card_session_slot_id, task_id, run_id, session_kind,
         architecture_schema_version, agent_card_id, execution_profile_id,
         profile_revision_id, generation, lifecycle, created_at
       ) VALUES (?, NULL, ?, ?, 'conductor', 3, ?, ?, NULL, 1, 'current', ?)`,
      "logical_session_conductor_without_revision", "task_logical_v20", "run_logical_v20",
      "agent_card_conductor_v20", "profile_conductor_v20", now,
    )).toThrow(/CHECK constraint failed/iu);
    upgraded.run(
      `INSERT INTO session_id_logical_sessions(
         session_id, card_session_slot_id, task_id, run_id, session_kind,
         architecture_schema_version, agent_card_id, execution_profile_id,
         profile_revision_id, generation, lifecycle, created_at
       ) VALUES (?, NULL, ?, ?, 'conductor', 3, ?, ?, ?, 1, 'current', ?)`,
      "logical_session_conductor_v21", "task_logical_v20", "run_logical_v20",
      "agent_card_conductor_v21", "profile_conductor_v21", "profile_revision_conductor_v21", now,
    );
    expect(() => upgraded.run(
      `INSERT INTO session_id_logical_sessions(
         session_id, card_session_slot_id, task_id, run_id, session_kind,
         architecture_schema_version, agent_card_id, execution_profile_id,
         profile_revision_id, generation, lifecycle, created_at
       ) VALUES (?, NULL, ?, ?, 'conductor', 3, ?, ?, ?, 1, 'current', ?)`,
      "logical_session_conductor_duplicate_v21", "task_logical_v20", "run_logical_v20",
      "agent_card_conductor_duplicate_v21", "profile_conductor_duplicate_v21",
      "profile_revision_conductor_duplicate_v21", now,
    )).toThrow(/UNIQUE constraint failed/iu);
    upgraded.close();
  });

  it("migrates a v3 definition-only unique constraint without losing the Version or asset foreign key", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-store-v3-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE templates (
        template_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL, active_version_id TEXT, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
      CREATE TABLE template_versions (
        template_version_id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(template_id),
        version INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(template_id, version),
        UNIQUE(template_id, definition_hash)
      );
    `);
    legacy.prepare(
      "INSERT INTO templates(template_id, slug, title, status, active_version_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("template_legacy", "legacy", "Legacy", "active", "template_version_legacy", 1, "2026-08-06T00:00:00.000Z", "2026-08-06T00:00:00.000Z");
    legacy.prepare(
      "INSERT INTO template_versions(template_version_id, template_id, version, schema_version, definition_json, definition_hash, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("template_version_legacy", "template_legacy", 1, 1, "{}", "fnv1a64:legacyhash", "2026-08-06T00:00:00.000Z", "2026-08-06T00:00:00.000Z");
    legacy.close();

    const store = new SqliteRuntimeStore({ path: databasePath });
    expect(store.one<{ asset_manifest_hash: string }>(
      "SELECT asset_manifest_hash FROM template_versions WHERE template_version_id = ?",
      "template_version_legacy",
    )?.asset_manifest_hash).toBe(EMPTY_TEMPLATE_ASSET_MANIFEST_HASH);
    // `template_assets` is created before the parent-table rebuild; this insert
    // proves its FK follows the rebuilt v4 parent table rather than a stale name.
    expect(() => store.run(
      "INSERT INTO template_assets(template_version_id, asset_path, content_type, byte_length, content_digest, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      "template_version_legacy", "prompts/legacy.bin", "application/octet-stream", 2, "fnv1a64:0000000000000000", new Uint8Array([0, 255]), "2026-08-06T00:00:00.000Z",
    )).not.toThrow();
    expect(store.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("21");
    store.close();
  });

});
