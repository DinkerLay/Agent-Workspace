const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createTerminalInputArbiter } = require("./terminal-input-arbiter.cjs");

const ACTIVE_STATES = new Set(["running", "stopping"]);

/**
 * Orca-inspired ownership boundary for Agent Workspace Sessions.
 *
 * It owns no agent reasoning: it resolves an already-approved launch profile,
 * claims one physical terminal, and protects that terminal with operation and
 * incarnation identities. Conductor only requests activation and input.
 */
function createSessionAuthority({
  ptyManager,
  databasePath = ":memory:",
  now = () => new Date().toISOString(),
  randomUUID = crypto.randomUUID,
} = {}) {
  if (!ptyManager?.start || !ptyManager?.get || !ptyManager?.write || !ptyManager?.stop) {
    throw new Error("Session Authority requires a PTY manager.");
  }
  ensureDatabaseDirectory(databasePath);
  const db = new DatabaseSync(databasePath);
  migrate(db);

  const activationByOperation = new Map();
  const activationBySession = new Map();
  const inputArbiter = createTerminalInputArbiter({
    resolveOwner: resolveLiveOwner,
    write: ({ workspaceSessionId, expectedIncarnationId, payload }) => {
      const session = ptyManager.write(workspaceSessionId, payload, { expectedIncarnationId });
      if (!session) throw new Error("terminal_write_rejected");
      return session;
    },
  });

  function registerLaunchProfile(input) {
    const profile = normalizeLaunchProfile(input);
    const fingerprint = fingerprintForProfile(profile);
    const currentOwner = ownerFor(profile.workspaceSessionId);
    if (currentOwner?.state === "active" && currentOwner.fingerprint !== fingerprint) {
      throw new Error("session_launch_profile_active_conflict");
    }

    db.prepare(
      `INSERT INTO session_launch_profiles
        (workspace_session_id, task_id, fingerprint, profile_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_session_id) DO UPDATE SET
         task_id = excluded.task_id,
         fingerprint = excluded.fingerprint,
         profile_json = excluded.profile_json,
         updated_at = excluded.updated_at`,
    ).run(profile.workspaceSessionId, profile.taskId, fingerprint, JSON.stringify(profile), now());

    return { workspaceSessionId: profile.workspaceSessionId, fingerprint, taskId: profile.taskId };
  }

  async function activateSession(input) {
    const workspaceSessionId = requiredString(input?.workspaceSessionId, "workspaceSessionId");
    const operationId = requiredString(input?.operationId, "operationId");
    const callerId = String(input?.callerId ?? "trusted-local-runtime").trim() || "trusted-local-runtime";
    const operationKey = `${callerId}\0${operationId}`;
    const profileRecord = profileFor(workspaceSessionId);
    if (!profileRecord) throw new Error("session_launch_profile_not_found");
    const profile = profileRecord.profile;
    const fingerprint = profileRecord.fingerprint;

    const persisted = operationFor({ callerId, operationId });
    if (persisted) {
      if (persisted.fingerprint !== fingerprint || persisted.workspaceSessionId !== workspaceSessionId) {
        throw new Error("session_activation_operation_conflict");
      }
      const pending = activationByOperation.get(operationKey);
      if (pending) return replay(await pending);
      if (persisted.status === "completed" && persisted.result) return replay(persisted.result);
      throw new Error("session_activation_operation_outcome_unknown");
    }

    const pendingForOperation = activationByOperation.get(operationKey);
    if (pendingForOperation) return replay(await pendingForOperation);

    const pendingForSession = activationBySession.get(workspaceSessionId);
    if (pendingForSession) {
      const joined = pendingForSession.then((result) => ({ ...result, disposition: "adopted" }));
      activationByOperation.set(operationKey, joined);
      persistOperation({ callerId, operationId, workspaceSessionId, fingerprint, status: "pending" });
      try {
        const result = await joined;
        completeOperation({ callerId, operationId, result });
        return result;
      } finally {
        activationByOperation.delete(operationKey);
      }
    }

    persistOperation({ callerId, operationId, workspaceSessionId, fingerprint, status: "pending" });
    const activation = activateProfile({ profile, fingerprint, callerId, operationId, reason: input?.reason });
    activationByOperation.set(operationKey, activation);
    activationBySession.set(workspaceSessionId, activation);
    try {
      const result = await activation;
      completeOperation({ callerId, operationId, result });
      return result;
    } catch (error) {
      failOperation({ callerId, operationId, error });
      throw error;
    } finally {
      activationByOperation.delete(operationKey);
      if (activationBySession.get(workspaceSessionId) === activation) {
        activationBySession.delete(workspaceSessionId);
      }
    }
  }

  async function activateProfile({ profile, fingerprint, callerId, operationId, reason }) {
    const existing = resolveLiveOwner(profile.workspaceSessionId);
    if (existing) {
      return Promise.resolve({
        disposition: "adopted",
        workspaceSessionId: profile.workspaceSessionId,
        owner: existing,
        session: ptyManager.get(existing.ptyId),
      });
    }

    const prior = ownerFor(profile.workspaceSessionId);
    if (prior?.state === "active") {
      // In v0 Electron Main owns every child process. A missing local PTY after
      // an app restart is therefore reconciled as stopped before a new claim.
      updateOwnerState(profile.workspaceSessionId, "stopped", { stoppedAt: now() });
    }

    const incarnationId = randomUUID();
    const generation = randomUUID();
    const owner = {
      workspaceSessionId: profile.workspaceSessionId,
      taskId: profile.taskId,
      ptyId: profile.workspaceSessionId,
      incarnationId,
      generation,
      fingerprint,
      state: "activating",
      createdAt: now(),
    };
    persistOwner(owner);

    try {
      const session = await ptyManager.start({
        id: profile.workspaceSessionId,
        taskId: profile.taskId,
        command: profile.command,
        args: profile.args,
        cwd: profile.cwd,
        model: profile.model,
        provider: profile.provider,
        cols: profile.cols,
        rows: profile.rows,
        stdin: profile.stdin,
        requirePty: profile.requirePty,
        env: profile.env,
        runtimeFiles: profile.runtimeFiles,
        incarnationId,
        generation,
      });
      if (session.incarnationId !== incarnationId || session.generation !== generation) {
        throw new Error("session_execution_owner_unknown");
      }
      const activeOwner = { ...owner, state: "active", activatedAt: now() };
      persistOwner(activeOwner);
      return {
        disposition: "created",
        workspaceSessionId: profile.workspaceSessionId,
        owner: publicOwner(activeOwner),
        session,
        operation: { callerId, operationId, reason: String(reason ?? "runtime") },
      };
    } catch (error) {
      persistOwner({ ...owner, state: "failed", failedAt: now() });
      throw error;
    }
  }

  async function enqueueInput(input) {
    return inputArbiter.enqueue({
      workspaceSessionId: input?.workspaceSessionId,
      expectedIncarnationId: input?.expectedIncarnationId,
      source: input?.source,
      payload: input?.payload,
      idempotencyKey: input?.idempotencyKey,
    });
  }

  function stopSession(input) {
    const workspaceSessionId = requiredString(input?.workspaceSessionId, "workspaceSessionId");
    const owner = resolveLiveOwner(workspaceSessionId);
    if (!owner) return undefined;
    if (input?.expectedIncarnationId && input.expectedIncarnationId !== owner.incarnationId) {
      throw new Error("terminal_incarnation_stale");
    }
    updateOwnerState(workspaceSessionId, "stopping", { stoppingAt: now() });
    return ptyManager.stop(owner.ptyId, { expectedIncarnationId: owner.incarnationId });
  }

  function resizeSession(input) {
    const workspaceSessionId = requiredString(input?.workspaceSessionId, "workspaceSessionId");
    const owner = resolveLiveOwner(workspaceSessionId);
    if (!owner) return undefined;
    if (input?.expectedIncarnationId && input.expectedIncarnationId !== owner.incarnationId) {
      throw new Error("terminal_incarnation_stale");
    }
    return ptyManager.resize(owner.ptyId, { cols: Number(input?.cols ?? 100), rows: Number(input?.rows ?? 30) }, {
      expectedIncarnationId: owner.incarnationId,
    });
  }

  function readSession(input) {
    const workspaceSessionId = requiredString(input?.workspaceSessionId, "workspaceSessionId");
    return ptyManager.read(workspaceSessionId, Number(input?.cursor ?? 0));
  }

  function handlePtyEvent(event) {
    const owner = ownerFor(String(event?.id ?? ""));
    if (!owner || owner.incarnationId !== event?.incarnationId || owner.generation !== event?.generation) {
      return { accepted: false, reason: "stale_or_unknown_incarnation" };
    }
    if (event.type === "exit") {
      updateOwnerState(owner.workspaceSessionId, "stopped", {
        stoppedAt: now(),
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
      });
    }
    return { accepted: true, owner: publicOwner(owner) };
  }

  function resolveLiveOwner(workspaceSessionId) {
    const owner = ownerFor(workspaceSessionId);
    if (!owner || owner.state !== "active") return undefined;
    const session = ptyManager.get(owner.ptyId);
    if (!session || !ACTIVE_STATES.has(session.status)) return undefined;
    if (session.incarnationId !== owner.incarnationId || session.generation !== owner.generation) return undefined;
    return publicOwner(owner);
  }

  function profileFor(workspaceSessionId) {
    const row = db.prepare("SELECT fingerprint, profile_json FROM session_launch_profiles WHERE workspace_session_id = ?").get(
      workspaceSessionId,
    );
    if (!row) return undefined;
    return { fingerprint: row.fingerprint, profile: JSON.parse(row.profile_json) };
  }

  function ownerFor(workspaceSessionId) {
    const row = db.prepare("SELECT * FROM terminal_session_owners WHERE workspace_session_id = ?").get(workspaceSessionId);
    return row ? deserializeOwner(row) : undefined;
  }

  function persistOwner(owner) {
    db.prepare(
      `INSERT INTO terminal_session_owners
        (workspace_session_id, task_id, pty_id, incarnation_id, generation, fingerprint, state, details_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_session_id) DO UPDATE SET
         task_id = excluded.task_id,
         pty_id = excluded.pty_id,
         incarnation_id = excluded.incarnation_id,
         generation = excluded.generation,
         fingerprint = excluded.fingerprint,
         state = excluded.state,
         details_json = excluded.details_json,
         updated_at = excluded.updated_at`,
    ).run(
      owner.workspaceSessionId,
      owner.taskId,
      owner.ptyId,
      owner.incarnationId,
      owner.generation,
      owner.fingerprint,
      owner.state,
      JSON.stringify(owner),
      now(),
    );
  }

  function updateOwnerState(workspaceSessionId, state, details = {}) {
    const owner = ownerFor(workspaceSessionId);
    if (!owner) return undefined;
    const next = { ...owner, ...details, state };
    persistOwner(next);
    return next;
  }

  function operationFor({ callerId, operationId }) {
    const row = db
      .prepare("SELECT * FROM session_activation_operations WHERE caller_id = ? AND operation_id = ?")
      .get(callerId, operationId);
    if (!row) return undefined;
    return {
      workspaceSessionId: row.workspace_session_id,
      fingerprint: row.fingerprint,
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
    };
  }

  function persistOperation({ callerId, operationId, workspaceSessionId, fingerprint, status }) {
    db.prepare(
      `INSERT INTO session_activation_operations
        (caller_id, operation_id, workspace_session_id, fingerprint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(caller_id, operation_id) DO UPDATE SET
         workspace_session_id = excluded.workspace_session_id,
         fingerprint = excluded.fingerprint,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    ).run(callerId, operationId, workspaceSessionId, fingerprint, status, now(), now());
  }

  function completeOperation({ callerId, operationId, result }) {
    db.prepare(
      `UPDATE session_activation_operations
       SET status = 'completed', result_json = ?, updated_at = ?
       WHERE caller_id = ? AND operation_id = ?`,
    ).run(JSON.stringify(result), now(), callerId, operationId);
  }

  function failOperation({ callerId, operationId, error }) {
    db.prepare(
      `UPDATE session_activation_operations
       SET status = 'failed', result_json = ?, updated_at = ?
       WHERE caller_id = ? AND operation_id = ?`,
    ).run(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), now(), callerId, operationId);
  }

  function close() {
    db.close();
  }

  return {
    registerLaunchProfile,
    activateSession,
    enqueueInput,
    stopSession,
    resizeSession,
    readSession,
    resolveLiveOwner,
    handlePtyEvent,
    close,
  };
}

function normalizeLaunchProfile(input) {
  const workspaceSessionId = requiredString(input?.workspaceSessionId, "workspaceSessionId");
  const taskId = requiredString(input?.taskId, "taskId");
  const command = requiredString(input?.command, "command");
  const cwd = requiredString(input?.cwd, "cwd");
  return {
    workspaceSessionId,
    taskId,
    command,
    args: Array.isArray(input?.args) ? input.args.map(String) : [],
    cwd,
    provider: String(input?.provider ?? "unknown"),
    model: input?.model ? String(input.model) : undefined,
    cols: Number.isFinite(Number(input?.cols)) ? Number(input.cols) : 100,
    rows: Number.isFinite(Number(input?.rows)) ? Number(input.rows) : 30,
    stdin: input?.stdin === "ignore" ? "ignore" : "pipe",
    requirePty: input?.requirePty !== false,
    env: normalizeStringRecord(input?.env),
    runtimeFiles: normalizeRuntimeFiles(input?.runtimeFiles),
  };
}

function normalizeStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => typeof key === "string" && typeof item === "string"));
}

function normalizeRuntimeFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.map((file) => ({ relativePath: String(file?.relativePath ?? ""), contents: String(file?.contents ?? "") }));
}

function fingerprintForProfile(profile) {
  return crypto.createHash("sha256").update(JSON.stringify(profile)).digest("base64url");
}

function deserializeOwner(row) {
  const details = row.details_json ? JSON.parse(row.details_json) : {};
  return {
    ...details,
    workspaceSessionId: row.workspace_session_id,
    taskId: row.task_id,
    ptyId: row.pty_id,
    incarnationId: row.incarnation_id,
    generation: row.generation,
    fingerprint: row.fingerprint,
    state: row.state,
  };
}

function publicOwner(owner) {
  return {
    workspaceSessionId: owner.workspaceSessionId,
    taskId: owner.taskId,
    ptyId: owner.ptyId,
    incarnationId: owner.incarnationId,
    generation: owner.generation,
    state: owner.state,
  };
}

function replay(result) {
  return { ...result, disposition: "replayed" };
}

function requiredString(value, field) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Session Authority ${field} is required.`);
  return result;
}

function ensureDatabaseDirectory(databasePath) {
  if (!databasePath || databasePath === ":memory:") return;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_launch_profiles (
      workspace_session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS terminal_session_owners (
      workspace_session_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      pty_id TEXT NOT NULL,
      incarnation_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      details_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session_activation_operations (
      caller_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      workspace_session_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (caller_id, operation_id)
    ) STRICT;
  `);
}

module.exports = { createSessionAuthority, fingerprintForProfile };
