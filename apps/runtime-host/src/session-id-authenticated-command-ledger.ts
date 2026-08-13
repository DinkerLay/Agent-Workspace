import { randomUUID } from "node:crypto";
import type { SqliteRuntimeStore } from "@agent-workspace/runtime-store";

export const SESSION_ID_AUTHENTICATED_RUNTIME_BRIDGE_SOURCE = "authenticated_runtime_bridge" as const;

export type SessionIdAuthenticatedCommandLedgerEntry = Readonly<{
  runtimeInstanceId: string;
  uiIntentId: string;
  commandId: string;
  intentKind: string;
  source: typeof SESSION_ID_AUTHENTICATED_RUNTIME_BRIDGE_SOURCE;
}>;

export type SessionIdAuthenticatedCommandLedger = Readonly<{
  runtimeInstanceId: string;
  recovered: boolean;
  recordSuccessfulCommand(input: Readonly<{
    uiIntentId: string;
    commandId: string;
    intentKind: string;
  }>): SessionIdAuthenticatedCommandLedgerEntry;
  readEntries(): readonly SessionIdAuthenticatedCommandLedgerEntry[];
}>;

/**
 * Host evidence issuer for authenticated Renderer commands.
 *
 * This deliberately owns no scenario/checkpoint vocabulary and accepts no
 * arbitrary payload. Provider credentials, native references and command
 * bodies therefore cannot enter the evidence ledger through this API.
 */
export function createSessionIdAuthenticatedCommandLedger(
  sqlite: SqliteRuntimeStore,
  options: Readonly<{ createId?: (kind: "runtime_instance") => string }> = {},
): SessionIdAuthenticatedCommandLedger {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS session_id_runtime_instances (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      runtime_instance_id TEXT NOT NULL UNIQUE
    )
  `);
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS session_id_authenticated_command_ledger (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      runtime_instance_id TEXT NOT NULL,
      ui_intent_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      intent_kind TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source = 'authenticated_runtime_bridge'),
      UNIQUE(runtime_instance_id, command_id)
    )
  `);
  let recovered = false;
  const runtimeInstanceId = sqlite.transaction(() => {
    const existing = sqlite.one<{ runtime_instance_id: string }>(
      "SELECT runtime_instance_id FROM session_id_runtime_instances WHERE singleton = 1",
    );
    if (existing) {
      recovered = true;
      return existing.runtime_instance_id;
    }
    const created = requiredText(
      options.createId?.("runtime_instance") ?? `runtime_instance_${randomUUID()}`,
      "session_id_runtime_instance_id_required",
    );
    sqlite.run(
      "INSERT INTO session_id_runtime_instances(singleton, runtime_instance_id) VALUES (1, ?)",
      created,
    );
    return created;
  });

  return Object.freeze({
    runtimeInstanceId,
    recovered,
    recordSuccessfulCommand(input) {
      const entry = Object.freeze({
        runtimeInstanceId,
        uiIntentId: requiredText(input.uiIntentId, "session_id_ui_intent_id_required"),
        commandId: requiredText(input.commandId, "session_id_command_id_required"),
        intentKind: requiredText(input.intentKind, "session_id_intent_kind_required"),
        source: SESSION_ID_AUTHENTICATED_RUNTIME_BRIDGE_SOURCE,
      });
      return sqlite.transaction(() => {
        const replay = find(entry.commandId);
        if (replay) {
          if (replay.uiIntentId !== entry.uiIntentId || replay.intentKind !== entry.intentKind) {
            throw new Error("session_id_command_ledger_identity_conflict");
          }
          return replay;
        }
        sqlite.run(
          `INSERT INTO session_id_authenticated_command_ledger(
            runtime_instance_id, ui_intent_id, command_id, intent_kind, source
          ) VALUES (?, ?, ?, ?, ?)`,
          entry.runtimeInstanceId,
          entry.uiIntentId,
          entry.commandId,
          entry.intentKind,
          entry.source,
        );
        return entry;
      });
    },
    readEntries() {
      return Object.freeze(sqlite.many<{
        runtime_instance_id: string;
        ui_intent_id: string;
        command_id: string;
        intent_kind: string;
        source: string;
      }>(
        `SELECT runtime_instance_id, ui_intent_id, command_id, intent_kind, source
         FROM session_id_authenticated_command_ledger
         WHERE runtime_instance_id = ?
         ORDER BY sequence ASC`,
        runtimeInstanceId,
      ).map(project));
    },
  });

  function find(commandId: string): SessionIdAuthenticatedCommandLedgerEntry | undefined {
    const row = sqlite.one<{
      runtime_instance_id: string;
      ui_intent_id: string;
      command_id: string;
      intent_kind: string;
      source: string;
    }>(
      `SELECT runtime_instance_id, ui_intent_id, command_id, intent_kind, source
       FROM session_id_authenticated_command_ledger
       WHERE runtime_instance_id = ? AND command_id = ?`,
      runtimeInstanceId,
      commandId,
    );
    return row ? project(row) : undefined;
  }
}

function project(row: Readonly<{
  runtime_instance_id: string;
  ui_intent_id: string;
  command_id: string;
  intent_kind: string;
  source: string;
}>): SessionIdAuthenticatedCommandLedgerEntry {
  if (row.source !== SESSION_ID_AUTHENTICATED_RUNTIME_BRIDGE_SOURCE) {
    throw new Error("session_id_command_ledger_source_invalid");
  }
  return Object.freeze({
    runtimeInstanceId: row.runtime_instance_id,
    uiIntentId: row.ui_intent_id,
    commandId: row.command_id,
    intentKind: row.intent_kind,
    source: SESSION_ID_AUTHENTICATED_RUNTIME_BRIDGE_SOURCE,
  });
}

function requiredText(value: string, code: string): string {
  if (!value.trim()) throw new Error(code);
  return value;
}
