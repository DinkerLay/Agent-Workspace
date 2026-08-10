import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_TEMPLATE_ASSET_MANIFEST_HASH } from "@agent-workspace/runtime-contracts";
import { SqliteRuntimeStore } from "./sqlite.js";

const paths: string[] = [];

afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("SqliteRuntimeStore", () => {
  it("creates the isolated Runtime schema and rolls back a failed transaction", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-store-"));
    paths.push(directory);
    const store = new SqliteRuntimeStore({ path: path.join(directory, "runtime.sqlite") });

    expect(store.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("12");
    expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('attentions') WHERE name = ?", "updated_at")?.name).toBe("updated_at");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "wakeups")).toBeUndefined();
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "invocation_results")).toBeUndefined();
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "session_messages")?.name).toBe("session_messages");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "relay_blocks")?.name).toBe("relay_blocks");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "session_inbox_items")?.name).toBe("session_inbox_items");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "message_forwards")?.name).toBe("message_forwards");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "human_interventions")?.name).toBe("human_interventions");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "session_turns")?.name).toBe("session_turns");
    expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('input_submissions') WHERE name = ?", "source_inbox_item_id")?.name).toBe("source_inbox_item_id");
    expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('invocations') WHERE name = ?", "assignment_message_id")?.name).toBe("assignment_message_id");
    expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('tasks') WHERE name = ?", "achievement_json")?.name).toBe("achievement_json");
    expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('template_versions') WHERE name = ?", "asset_manifest_hash")?.name).toBe("asset_manifest_hash");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "template_assets")?.name).toBe("template_assets");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "workspace_authorizations")?.name).toBe("workspace_authorizations");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "task_setup_drafts")?.name).toBe("task_setup_drafts");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "meta_sessions")?.name).toBe("meta_sessions");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "meta_messages")?.name).toBe("meta_messages");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "meta_patch_proposals")?.name).toBe("meta_patch_proposals");
    expect(store.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "meta_turns")?.name).toBe("meta_turns");
    for (const column of ["system_instructions", "system_instructions_digest", "output_schema_json", "output_schema_digest"]) {
      expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('meta_turns') WHERE name = ?", column)?.name).toBe(column);
    }
    expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('task_architecture_snapshots') WHERE name = ?", "task_goal_content_digest")?.name).toBe("task_goal_content_digest");
    expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('session_messages') WHERE name = ?", "task_goal_compiler_version")?.name).toBe("task_goal_compiler_version");
    expect(store.one<{ name: string }>("SELECT name FROM pragma_table_info('artifacts') WHERE name = ?", "source_message_id")?.name).toBe("source_message_id");
    expect(() => store.transaction(() => {
      store.run(
        "INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "template-1", "research", "Research", "active", 1, store.now(), store.now(),
      );
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.one("SELECT template_id FROM templates WHERE template_id = ?", "template-1")).toBeUndefined();
    store.transaction(() => {
      store.run(
        "INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "template-outer-a", "outer-a", "Outer A", "active", 1, store.now(), store.now(),
      );
      expect(() => store.transaction(() => {
        store.run(
          "INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          "template-inner", "inner", "Inner", "active", 1, store.now(), store.now(),
        );
        throw new Error("inner-rollback");
      })).toThrow("inner-rollback");
      store.run(
        "INSERT INTO templates(template_id, slug, title, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "template-outer-b", "outer-b", "Outer B", "active", 1, store.now(), store.now(),
      );
    });
    expect(store.one("SELECT template_id FROM templates WHERE template_id = ?", "template-outer-a")).toBeDefined();
    expect(store.one("SELECT template_id FROM templates WHERE template_id = ?", "template-inner")).toBeUndefined();
    expect(store.one("SELECT template_id FROM templates WHERE template_id = ?", "template-outer-b")).toBeDefined();
    store.close();
  });

  it("migrates v11 by adding the configuration-owned Meta turn queue and active-turn fence", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-meta-turn-v11-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    new SqliteRuntimeStore({ path: databasePath }).close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE meta_turns;
      UPDATE runtime_meta SET value = '11' WHERE key = 'schema_version';
    `);
    legacy.close();

    const migrated = new SqliteRuntimeStore({ path: databasePath });
    expect(migrated.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("12");
    expect(migrated.one<{ name: string }>("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "meta_turns")?.name)
      .toBe("meta_turns");
    expect(migrated.one<{ name: string; unique: number }>("SELECT name, \"unique\" FROM pragma_index_list('meta_turns') WHERE name = ?", "meta_turns_active_session_idx"))
      .toEqual({ name: "meta_turns_active_session_idx", unique: 1 });
    migrated.close();
  });

  it("migrates the v10 byte-based Artifact uniqueness to canonical Message claims", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-artifact-v10-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    new SqliteRuntimeStore({ path: databasePath }).close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE artifacts RENAME TO artifacts_v11_current;
      CREATE TABLE artifacts (
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
        UNIQUE(task_id, workspace_relative_path, content_digest)
      );
      DROP TABLE artifacts_v11_current;
      UPDATE runtime_meta SET value = '10' WHERE key = 'schema_version';
    `);
    legacy.close();

    const migrated = new SqliteRuntimeStore({ path: databasePath });
    const uniqueFields = migrated.many<{ name: string; unique: number }>("PRAGMA index_list('artifacts')")
      .filter((index) => index.unique === 1)
      .map((index) => migrated.many<{ name: string; seqno: number }>(`PRAGMA index_info('${index.name}')`)
        .sort((left, right) => left.seqno - right.seqno)
        .map((field) => field.name)
        .join(","));
    expect(uniqueFields).toContain("source_message_id,workspace_relative_path");
    expect(uniqueFields).not.toContain("task_id,workspace_relative_path,content_digest");
    expect(migrated.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("12");
    migrated.close();
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
    expect(store.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("12");
    store.close();
  });

  it("direct-cuts the v6 result/wakeup execution graph without fabricating Message history", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-store-v6-message-cut-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const fresh = new SqliteRuntimeStore({ path: databasePath });
    fresh.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE session_inbox_items;
      DROP TABLE relay_blocks;
      DROP TABLE session_messages;
      DROP TABLE invocations;
      DROP TABLE input_submissions;

      CREATE TABLE input_submissions (
        input_submission_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        logical_session_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
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
      CREATE TABLE invocations (
        invocation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        conductor_logical_session_id TEXT NOT NULL,
        target_logical_session_id TEXT NOT NULL,
        target_agent_card_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        input_submission_id TEXT NOT NULL,
        status TEXT NOT NULL,
        objective TEXT NOT NULL,
        context_refs_json TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        requested_artifacts_json TEXT NOT NULL,
        priority TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE invocation_results (
        invocation_result_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        binding_id TEXT NOT NULL,
        provider_fact_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        evidence_reference_ids_json TEXT NOT NULL,
        returned_at TEXT NOT NULL
      );
      CREATE TABLE wakeups (
        wakeup_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        invocation_id TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      );
      UPDATE runtime_meta SET value = '6' WHERE key = 'schema_version';
    `);
    const now = "2026-08-07T00:00:00.000Z";
    legacy.prepare(
      "INSERT INTO templates(template_id, slug, title, status, active_version_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("template_message_cut", "message-cut", "Message cut", "active", "template_version_message_cut", 1, now, now);
    legacy.prepare(
      "INSERT INTO template_versions(template_version_id, template_id, version, schema_version, definition_json, definition_hash, asset_manifest_hash, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("template_version_message_cut", "template_message_cut", 1, 2, "{}", "fnv1a64:messagecut", EMPTY_TEMPLATE_ASSET_MANIFEST_HASH, now, now);
    legacy.prepare(
      "INSERT INTO task_architecture_snapshots(architecture_snapshot_id, task_id, template_id, template_version_id, template_definition_hash, definition_json, workspace_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("architecture_message_cut", "task_message_cut", "template_message_cut", "template_version_message_cut", "fnv1a64:messagecut", "{}", "{\"workspaceId\":\"workspace_message_cut\",\"cwd\":\"/project\"}", now);
    legacy.prepare(
      "INSERT INTO tasks(task_id, architecture_snapshot_id, title, goal, status, active_run_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("task_message_cut", "architecture_message_cut", "Message cut", "Direct-cut legacy execution state.", "running", "run_message_cut", 4, now, now);
    legacy.prepare(
      "INSERT INTO task_runs(run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("run_message_cut", "task_message_cut", "logical_session_conductor", "running", 1, 1, now);
    legacy.prepare(
      "INSERT INTO logical_sessions(logical_session_id, task_id, run_id, agent_card_id, kind, execution_profile_id, status, ordinal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("logical_session_conductor", "task_message_cut", "run_message_cut", "agent_card_conductor", "conductor", "profile_message_cut", "active", 0, now, now);
    legacy.prepare(
      "INSERT INTO provider_session_bindings(binding_id, task_id, run_id, logical_session_id, execution_profile_id, provider_id, binding_revision, status, recoverable, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("binding_message_cut", "task_message_cut", "run_message_cut", "logical_session_conductor", "profile_message_cut", "opencode", 1, "active", 1, now, now);
    legacy.prepare(
      "INSERT INTO input_submissions(input_submission_id, task_id, run_id, logical_session_id, binding_id, command_id, idempotency_key, content_digest, content, sequence_number, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("input_message_cut", "task_message_cut", "run_message_cut", "logical_session_conductor", "binding_message_cut", "command_message_cut", "input-message-cut", "sha256:message-cut", "legacy input", 1, "provider_received", now, now);
    legacy.prepare(
      "INSERT INTO invocations(invocation_id, task_id, run_id, conductor_logical_session_id, target_logical_session_id, target_agent_card_id, binding_id, input_submission_id, status, objective, context_refs_json, acceptance_criteria_json, requested_artifacts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("invocation_message_cut", "task_message_cut", "run_message_cut", "logical_session_conductor", "logical_session_conductor", "agent_card_conductor", "binding_message_cut", "input_message_cut", "return_available", "Legacy result", "[]", "[\"Return\"]", "[]", now, now);
    legacy.prepare(
      "INSERT INTO invocation_results(invocation_result_id, invocation_id, task_id, run_id, binding_id, provider_fact_id, result_json, evidence_reference_ids_json, returned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("invocation_result_message_cut", "invocation_message_cut", "task_message_cut", "run_message_cut", "binding_message_cut", "provider_fact_message_cut", "{\"summary\":\"not a final message\"}", "[]", now);
    legacy.prepare(
      "INSERT INTO wakeups(wakeup_id, task_id, run_id, invocation_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("wakeup_message_cut", "task_message_cut", "run_message_cut", "invocation_message_cut", "invocation_result", now);
    legacy.prepare(
      "INSERT INTO artifacts(artifact_id, task_id, run_id, workspace_relative_path, content_digest, source_invocation_id, evidence_reference_ids_json, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("artifact_message_cut", "task_message_cut", "run_message_cut", "reports/legacy.md", "sha256:legacy", "invocation_message_cut", "[]", now);
    legacy.close();

    const store = new SqliteRuntimeStore({ path: databasePath, now: () => "2026-08-07T01:00:00.000Z" });
    expect(store.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("12");
    expect(store.one<{ active_run_id: string | null; status: string; revision: number }>("SELECT active_run_id, status, revision FROM tasks WHERE task_id = ?", "task_message_cut"))
      .toEqual({ active_run_id: null, status: "queued", revision: 5 });
    expect(store.one<{ status: string; ended_at: string; revision: number }>("SELECT status, ended_at, revision FROM task_runs WHERE run_id = ?", "run_message_cut"))
      .toEqual({ status: "failed", ended_at: "2026-08-07T01:00:00.000Z", revision: 2 });
    expect(store.one<{ status: string }>("SELECT status FROM logical_sessions WHERE logical_session_id = ?", "logical_session_conductor"))
      .toEqual({ status: "unrecoverable" });
    expect(store.one("SELECT binding_id FROM provider_session_bindings WHERE binding_id = ?", "binding_message_cut")).toBeUndefined();
    expect(store.one("SELECT input_submission_id FROM input_submissions WHERE input_submission_id = ?", "input_message_cut")).toBeUndefined();
    expect(store.one("SELECT invocation_id FROM invocations WHERE invocation_id = ?", "invocation_message_cut")).toBeUndefined();
    expect(store.one("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "invocation_results")).toBeUndefined();
    expect(store.one("SELECT name FROM sqlite_master WHERE type = ? AND name = ?", "table", "wakeups")).toBeUndefined();
    // The migration never touches `reports/legacy.md` or its managed Artifact
    // record, but it removes the now-unprovable old Invocation source link.
    expect(store.one<{ source_invocation_id: string | null }>("SELECT source_invocation_id FROM artifacts WHERE artifact_id = ?", "artifact_message_cut"))
      .toEqual({ source_invocation_id: null });
    expect(store.one("SELECT architecture_snapshot_id FROM task_architecture_snapshots WHERE task_id = ?", "task_message_cut")).toBeDefined();
    store.close();

    const reopened = new SqliteRuntimeStore({ path: databasePath });
    expect(reopened.one<{ revision: number }>("SELECT revision FROM tasks WHERE task_id = ?", "task_message_cut"))
      .toEqual({ revision: 5 });
    reopened.close();
  });

  it("direct-cuts the v8 visibility kernel without fabricating v9 Forward or Turn history", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-workspace-store-v7-message-cycle-"));
    paths.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const fresh = new SqliteRuntimeStore({ path: databasePath });
    fresh.close();

    const legacy = new DatabaseSync(databasePath);
    const now = "2026-08-07T02:00:00.000Z";
    legacy.prepare(
      "INSERT INTO templates(template_id, slug, title, status, active_version_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("template_message_cycle", "message-cycle", "Message cycle", "active", "template_version_message_cycle", 1, now, now);
    legacy.prepare(
      "INSERT INTO template_versions(template_version_id, template_id, version, schema_version, definition_json, definition_hash, asset_manifest_hash, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("template_version_message_cycle", "template_message_cycle", 1, 2, "{}", "fnv1a64:messagecycle", EMPTY_TEMPLATE_ASSET_MANIFEST_HASH, now, now);
    legacy.prepare(
      "INSERT INTO task_architecture_snapshots(architecture_snapshot_id, task_id, template_id, template_version_id, template_definition_hash, definition_json, workspace_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("architecture_message_cycle", "task_message_cycle", "template_message_cycle", "template_version_message_cycle", "fnv1a64:messagecycle", "{}", "{\"workspaceId\":\"workspace_message_cycle\",\"cwd\":\"/project\"}", now);
    legacy.prepare(
      "INSERT INTO tasks(task_id, architecture_snapshot_id, title, goal, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("task_message_cycle", "architecture_message_cycle", "Message cycle", "Keep Message data.", "queued", 1, now, now);
    legacy.prepare(
      "INSERT INTO task_runs(run_id, task_id, conductor_logical_session_id, status, run_number, revision, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("run_message_cycle", "task_message_cycle", "logical_session_legacy", "stopped", 1, 1, now);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE message_forward_selections;
      DROP TABLE message_forwards;
      DROP TABLE message_forward_batches;
      DROP TABLE session_turns;
      DROP TABLE human_interventions;
      DROP TABLE input_submissions;
      DROP TABLE session_inbox_items;
      DROP TABLE relay_blocks;
      DROP TABLE session_messages;
      CREATE TABLE session_messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        run_id TEXT NOT NULL REFERENCES task_runs(run_id),
        source_logical_session_id TEXT REFERENCES logical_sessions(logical_session_id),
        invocation_id TEXT REFERENCES invocations(invocation_id),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        origin_message_id TEXT REFERENCES session_messages(message_id),
        origin_relay_block_id TEXT REFERENCES relay_blocks(relay_block_id),
        relayed_by_logical_session_id TEXT REFERENCES logical_sessions(logical_session_id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE relay_blocks (
        relay_block_id TEXT PRIMARY KEY,
        source_message_id TEXT NOT NULL REFERENCES session_messages(message_id),
        ordinal INTEGER NOT NULL,
        visibility TEXT NOT NULL,
        target_agent_card_ids_json TEXT NOT NULL,
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
      UPDATE runtime_meta SET value = '8' WHERE key = 'schema_version';
      PRAGMA foreign_keys = ON;
    `);
    legacy.prepare(
      "INSERT INTO session_messages(message_id, task_id, run_id, kind, content, content_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("message_cycle", "task_message_cycle", "run_message_cycle", "task_goal", "Keep this exact Message.", "sha256:message-cycle", now);
    legacy.prepare(
      "INSERT INTO relay_blocks(relay_block_id, source_message_id, ordinal, visibility, target_agent_card_ids_json, format, content, content_digest, parser_version, source_start, source_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("relay_block_cycle", "message_cycle", 0, "shared", "[]", "text/markdown", "Visible relay", "sha256:relay-cycle", 1, 0, 10, now);
    legacy.close();

    const migrated = new SqliteRuntimeStore({ path: databasePath });
    expect(migrated.one<{ content: string }>("SELECT content FROM session_messages WHERE message_id = ?", "message_cycle"))
      .toBeUndefined();
    expect(migrated.one<{ content: string }>("SELECT content FROM relay_blocks WHERE relay_block_id = ?", "relay_block_cycle"))
      .toBeUndefined();
    expect(migrated.one<{ table: string }>("SELECT \"table\" FROM pragma_foreign_key_list('session_messages') WHERE \"from\" = ?", "invocation_id"))
      .toBeUndefined();
    expect(migrated.one<{ value: string }>("SELECT value FROM runtime_meta WHERE key = ?", "schema_version")?.value).toBe("12");
    migrated.close();
  });
});
