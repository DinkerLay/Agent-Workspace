import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRuntimeStore } from "@agent-workspace/runtime-store";
import { createSessionIdAuthenticatedCommandLedger } from "./session-id-authenticated-command-ledger.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Session-ID authenticated command ledger", () => {
  it("persists one bounded command identity and reuses the Runtime instance across reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "session-id-ledger-"));
    directories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const firstSqlite = new SqliteRuntimeStore({ path: databasePath });
    const first = createSessionIdAuthenticatedCommandLedger(firstSqlite, {
      createId: () => "runtime_instance_stable",
    });

    expect(first.recordSuccessfulCommand({
      uiIntentId: "ui_start_1",
      commandId: "command_start_1",
      intentKind: "task.start",
    })).toEqual({
      runtimeInstanceId: "runtime_instance_stable",
      uiIntentId: "ui_start_1",
      commandId: "command_start_1",
      intentKind: "task.start",
      source: "authenticated_runtime_bridge",
    });
    expect(first.recordSuccessfulCommand({
      uiIntentId: "ui_start_1",
      commandId: "command_start_1",
      intentKind: "task.start",
    })).toEqual(first.readEntries()[0]);
    firstSqlite.close();

    const reopenedSqlite = new SqliteRuntimeStore({ path: databasePath });
    const reopened = createSessionIdAuthenticatedCommandLedger(reopenedSqlite, {
      createId: () => "runtime_instance_must_not_replace",
    });
    expect(reopened.runtimeInstanceId).toBe("runtime_instance_stable");
    expect(reopened.readEntries()).toEqual([{
      runtimeInstanceId: "runtime_instance_stable",
      uiIntentId: "ui_start_1",
      commandId: "command_start_1",
      intentKind: "task.start",
      source: "authenticated_runtime_bridge",
    }]);
    expect(() => reopened.recordSuccessfulCommand({
      uiIntentId: "ui_conflict",
      commandId: "command_start_1",
      intentKind: "task.restart",
    })).toThrowError("session_id_command_ledger_identity_conflict");
    reopenedSqlite.close();
  });
});
