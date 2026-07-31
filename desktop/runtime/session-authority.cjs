const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createTerminalInputArbiter } = require("./terminal-input-arbiter.cjs");

const ACTIVE_STATES = new Set(["running", "stopping"]);
const DEFAULT_INTERACTIVE_TUI_READY_TIMEOUT_MS = 20_000;
const DEFAULT_TERMINAL_EXIT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERACTIVE_INPUT_SETTLE_TIMEOUT_MS = 350;
// The alternate-buffer transition means OpenCode owns the screen, but its
// resumed Session route needs one render turn before its composer accepts
// input. This is a terminal startup fence, not Task-routing policy.
const DEFAULT_INTERACTIVE_TUI_STABILIZE_MS = 1_200;

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
  interactiveTuiStabilizeMs = DEFAULT_INTERACTIVE_TUI_STABILIZE_MS,
} = {}) {
  if (!ptyManager?.start || !ptyManager?.get || !ptyManager?.write || !ptyManager?.stop) {
    throw new Error("Session Authority requires a PTY manager.");
  }
  ensureDatabaseDirectory(databasePath);
  const db = new DatabaseSync(databasePath);
  migrate(db);

  const activationByOperation = new Map();
  const activationBySession = new Map();
  const interactiveReadyWaiters = new Map();
  const interactiveReadyAt = new Map();
  const interactiveOutputAt = new Map();
  const terminalExitWaiters = new Map();
  const inputRenderWaiters = new Map();
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
      const liveOwner = resolveLiveOwner(profile.workspaceSessionId);
      if (liveOwner) throw new Error("session_launch_profile_active_conflict");
      // A terminal owned by this Electron Main process cannot survive after
      // Main restarts. Its durable owner record can, and a fresh bridge token
      // changes the launch fingerprint. Reconcile only this proven-dead owner
      // before replacing the profile; never replace a live physical terminal.
      updateOwnerState(profile.workspaceSessionId, "stopped", {
        stoppedAt: now(),
        reason: "stale_owner_reconciled_before_profile_replacement",
      });
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
    const activation = activateProfile({
      profile,
      fingerprint,
      callerId,
      operationId,
      reason: input?.reason,
      interactiveTui: input?.interactiveTui === true,
    });
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

  async function activateProfile({ profile, fingerprint, callerId, operationId, reason, interactiveTui = false }) {
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
    // A new terminal generation must prove its own TUI readiness. Never let a
    // previous PTY's transition timestamp satisfy a recovered OpenCode route.
    interactiveReadyAt.delete(profile.workspaceSessionId);
    interactiveOutputAt.delete(profile.workspaceSessionId);

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
      if (interactiveTui) {
        await waitForInteractiveTui({
          workspaceSessionId: profile.workspaceSessionId,
          expectedIncarnationId: incarnationId,
          expectedGeneration: generation,
        });
        await waitForInteractiveTuiStabilization({
          workspaceSessionId: profile.workspaceSessionId,
          expectedIncarnationId: incarnationId,
          expectedGeneration: generation,
          profile,
        });
      }
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

  /**
   * OpenCode's TUI handles a bracketed paste asynchronously.  A Return written
   * in the same PTY frame can therefore arrive before the pasted text exists in
   * the composer, which leaves a visible "[Pasted]" marker but submits nothing.
   * Keep the two terminal writes owned and ordered here: wait for the TUI's
   * post-paste render fact, then submit. Some OpenCode Session routes do not
   * emit a terminal delta for an unchanged off-screen composer, so the same
   * fence falls back to a short TUI-event-loop settle window. This is enough
   * for OpenCode's asynchronous paste handler to finish while avoiding the
   * invalid same-frame paste-and-Return sequence.
   */
  async function enqueueInteractiveSubmission(input) {
    const workspaceSessionId = requiredString(input?.workspaceSessionId, "workspaceSessionId");
    const expectedIncarnationId = requiredString(input?.expectedIncarnationId, "expectedIncarnationId");
    const source = input?.source;
    const body = String(input?.text ?? "").trimEnd();
    if (!body) throw new Error("terminal_interactive_submission_empty");
    const owner = resolveLiveOwner(workspaceSessionId);
    if (!owner) throw new Error("terminal_session_not_active");
    if (owner.incarnationId !== expectedIncarnationId) throw new Error("terminal_incarnation_stale");
    await waitForInteractiveTui({
      workspaceSessionId,
      expectedIncarnationId: owner.incarnationId,
      expectedGeneration: owner.generation,
    });
    await waitForInteractiveTuiStabilization({
      workspaceSessionId,
      expectedIncarnationId: owner.incarnationId,
      expectedGeneration: owner.generation,
      profile: profileFor(workspaceSessionId)?.profile,
    });
    const beforeCursor = Number(ptyManager.get(owner.ptyId)?.cursor ?? 0);
    const rendered = waitForTerminalRender({
      workspaceSessionId,
      expectedIncarnationId: owner.incarnationId,
      expectedGeneration: owner.generation,
      afterCursor: beforeCursor,
      settleTimeoutMs: input?.settleTimeoutMs,
    });
    const idempotencyKey = String(input?.idempotencyKey ?? "").trim();
    const paste = await enqueueInput({
      workspaceSessionId,
      expectedIncarnationId: owner.incarnationId,
      source,
      payload: `\x1b[200~${body}\x1b[201~`,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:paste` : undefined,
    });
    await rendered;
    const submit = await enqueueInput({
      workspaceSessionId,
      expectedIncarnationId: owner.incarnationId,
      source,
      payload: "\r",
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:submit` : undefined,
    });
    return { disposition: "submitted", workspaceSessionId, incarnationId: owner.incarnationId, paste, result: submit.result };
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

  /**
   * Release authority metadata only after the caller has observed this Task's
   * PTYs stop. The renderer never receives these records or process handles.
   */
  function releaseTask(input) {
    const taskId = requiredString(input?.taskId, "taskId");
    const rows = db.prepare("SELECT workspace_session_id FROM session_launch_profiles WHERE task_id = ?").all(taskId);
    const releasedSessionIds = rows.map((row) => String(row.workspace_session_id));
    db.prepare("DELETE FROM session_activation_operations WHERE workspace_session_id IN (SELECT workspace_session_id FROM session_launch_profiles WHERE task_id = ?)").run(taskId);
    db.prepare("DELETE FROM terminal_session_incarnations WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM terminal_session_owners WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM session_launch_profiles WHERE task_id = ?").run(taskId);
    return { taskId, releasedSessionIds };
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

  // This is a durable Terminal Runtime fact, not a renderer-facing PTY
  // handle.  The Dispatch Coordinator uses it after an Electron restart to
  // settle a cancellation only when the same terminal incarnation is known to
  // have exited.  An absent in-memory PTY is deliberately not enough.
  function readSessionOwner(input) {
    const workspaceSessionId = requiredString(input?.workspaceSessionId, "workspaceSessionId");
    const incarnationId = optionalString(input?.incarnationId);
    const generation = optionalString(input?.generation);
    if (Boolean(incarnationId) !== Boolean(generation)) {
      throw new Error("Session Authority exact terminal facts require both incarnationId and generation.");
    }
    const owner = incarnationId
      ? ownerForIncarnation({ workspaceSessionId, incarnationId, generation })
      : ownerFor(workspaceSessionId);
    return owner ? publicOwner(owner) : undefined;
  }

  function handlePtyEvent(event) {
    const owner = ownerFor(String(event?.id ?? ""));
    if (!owner || owner.incarnationId !== event?.incarnationId || owner.generation !== event?.generation) {
      return { accepted: false, reason: "stale_or_unknown_incarnation" };
    }
    if (event.type === "data" && event.bufferMode === "alternate") {
      markInteractiveTuiReady(owner);
      markInteractiveOutput(owner);
      settleInteractiveTuiWaiters(owner.workspaceSessionId, {
        session: ptyManager.get(owner.ptyId),
        incarnationId: owner.incarnationId,
        generation: owner.generation,
      });
    }
    if (event.type === "data" && event.bufferMode === "normal") {
      interactiveReadyAt.delete(owner.workspaceSessionId);
      interactiveOutputAt.delete(owner.workspaceSessionId);
    }
    if (event.type === "data") {
      settleInputRenderWaiters(owner.workspaceSessionId, {
        cursor: Number(event.cursor ?? 0),
        incarnationId: owner.incarnationId,
        generation: owner.generation,
      });
    }
    if (event.type === "exit") {
      interactiveReadyAt.delete(owner.workspaceSessionId);
      interactiveOutputAt.delete(owner.workspaceSessionId);
      rejectInteractiveTuiWaiters(owner.workspaceSessionId, new Error("terminal_exited_before_interactive_tui_ready"));
      rejectInputRenderWaiters(owner.workspaceSessionId, new Error("terminal_exited_before_interactive_submission"));
      const stoppedOwner = updateOwnerState(owner.workspaceSessionId, "stopped", {
        stoppedAt: now(),
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
      });
      settleTerminalExitWaiters(owner.workspaceSessionId, stoppedOwner);
    }
    return { accepted: true, owner: publicOwner(owner) };
  }

  // A physical PTY becoming `running` only means it was spawned. OpenCode
  // first configures its terminal and then enters the alternate buffer that
  // hosts its interactive TUI. Sending before that transition loses bytes to
  // shell startup. This is a terminal transport fact, never a Provider or
  // Task-routing inference.
  function waitForInteractiveTui({ workspaceSessionId, expectedIncarnationId, expectedGeneration, timeoutMs = DEFAULT_INTERACTIVE_TUI_READY_TIMEOUT_MS } = {}) {
    const owner = resolveLiveOwner(requiredString(workspaceSessionId, "workspaceSessionId"));
    if (!owner) return Promise.reject(new Error("terminal_session_not_active"));
    if (expectedIncarnationId && owner.incarnationId !== expectedIncarnationId) {
      return Promise.reject(new Error("terminal_incarnation_stale"));
    }
    if (expectedGeneration && owner.generation !== expectedGeneration) {
      return Promise.reject(new Error("terminal_generation_stale"));
    }
    const session = ptyManager.get(owner.ptyId);
    if (session?.bufferMode === "alternate") {
      markInteractiveTuiReady(owner);
      return Promise.resolve(session);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        expectedIncarnationId: owner.incarnationId,
        expectedGeneration: owner.generation,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        removeInteractiveTuiWaiter(owner.workspaceSessionId, waiter);
        reject(new Error("terminal_interactive_tui_not_ready"));
      }, Math.max(1, Number(timeoutMs) || DEFAULT_INTERACTIVE_TUI_READY_TIMEOUT_MS));
      timer.unref?.();
      const waiters = interactiveReadyWaiters.get(owner.workspaceSessionId) ?? [];
      waiters.push(waiter);
      interactiveReadyWaiters.set(owner.workspaceSessionId, waiters);
    });
  }

  async function waitForInteractiveTuiStabilization({ workspaceSessionId, expectedIncarnationId, expectedGeneration, profile } = {}) {
    const owner = resolveLiveOwner(requiredString(workspaceSessionId, "workspaceSessionId"));
    if (!owner) return Promise.reject(new Error("terminal_session_not_active"));
    if (expectedIncarnationId && owner.incarnationId !== expectedIncarnationId) {
      return Promise.reject(new Error("terminal_incarnation_stale"));
    }
    if (expectedGeneration && owner.generation !== expectedGeneration) {
      return Promise.reject(new Error("terminal_generation_stale"));
    }
    // Session-route OpenCode restores history asynchronously. It has no stable
    // visible prompt label after a completed turn (the composer can be blank),
    // so a text matcher is not a valid readiness fact. For a recovered profile
    // we instead wait until its own alternate-buffer output has been quiet for
    // one bounded window. Fresh Home-route launches use --prompt and retain the
    // existing short startup fence.
    const quietMs = Number(profile?.interactiveReadyQuietMs) || Number(interactiveTuiStabilizeMs);
    while (true) {
      const current = resolveLiveOwner(workspaceSessionId);
      if (!current) throw new Error("terminal_session_not_active");
      if (expectedIncarnationId && current.incarnationId !== expectedIncarnationId) {
        throw new Error("terminal_incarnation_stale");
      }
      if (expectedGeneration && current.generation !== expectedGeneration) {
        throw new Error("terminal_generation_stale");
      }
      const ready = markInteractiveTuiReady(current);
      const output = interactiveOutputAt.get(workspaceSessionId);
      const atMs = output?.incarnationId === current.incarnationId && output?.generation === current.generation
        ? output.atMs
        : ready.atMs;
      const remaining = Math.max(0, quietMs - Math.max(0, Date.now() - atMs));
      if (!remaining) return;
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  function markInteractiveTuiReady(owner) {
    const previous = interactiveReadyAt.get(owner.workspaceSessionId);
    if (previous && previous.incarnationId === owner.incarnationId && previous.generation === owner.generation) {
      return previous;
    }
    const ready = { incarnationId: owner.incarnationId, generation: owner.generation, atMs: Date.now() };
    interactiveReadyAt.set(owner.workspaceSessionId, ready);
    return ready;
  }

  function markInteractiveOutput(owner) {
    const output = { incarnationId: owner.incarnationId, generation: owner.generation, atMs: Date.now() };
    interactiveOutputAt.set(owner.workspaceSessionId, output);
    return output;
  }

  // Recovery may race an existing process that has received a stop signal but
  // has not emitted its authoritative PTY exit yet.  Replacing its launch
  // profile before that fact would either conflict or create a second process.
  function waitForTerminalExit({ workspaceSessionId, expectedIncarnationId, expectedGeneration, timeoutMs = DEFAULT_TERMINAL_EXIT_TIMEOUT_MS } = {}) {
    const id = requiredString(workspaceSessionId, "workspaceSessionId");
    const owner = ownerFor(id);
    if (!owner) return Promise.resolve(undefined);
    if (expectedIncarnationId && owner.incarnationId !== expectedIncarnationId) return Promise.reject(new Error("terminal_incarnation_stale"));
    if (expectedGeneration && owner.generation !== expectedGeneration) return Promise.reject(new Error("terminal_generation_stale"));
    if (["stopped", "failed"].includes(owner.state)) return Promise.resolve(publicOwner(owner));
    return new Promise((resolve, reject) => {
      const waiter = {
        expectedIncarnationId: owner.incarnationId,
        expectedGeneration: owner.generation,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        removeTerminalExitWaiter(id, waiter);
        reject(new Error("terminal_exit_not_confirmed"));
      }, Math.max(1, Number(timeoutMs) || DEFAULT_TERMINAL_EXIT_TIMEOUT_MS));
      timer.unref?.();
      const waiters = terminalExitWaiters.get(id) ?? [];
      waiters.push(waiter);
      terminalExitWaiters.set(id, waiters);
    });
  }

  function waitForTerminalRender({ workspaceSessionId, expectedIncarnationId, expectedGeneration, afterCursor, settleTimeoutMs = DEFAULT_INTERACTIVE_INPUT_SETTLE_TIMEOUT_MS } = {}) {
    const owner = resolveLiveOwner(requiredString(workspaceSessionId, "workspaceSessionId"));
    if (!owner) return Promise.reject(new Error("terminal_session_not_active"));
    if (expectedIncarnationId && owner.incarnationId !== expectedIncarnationId) return Promise.reject(new Error("terminal_incarnation_stale"));
    if (expectedGeneration && owner.generation !== expectedGeneration) return Promise.reject(new Error("terminal_generation_stale"));
    const cursor = Number(ptyManager.get(owner.ptyId)?.cursor ?? 0);
    const threshold = Math.max(0, Number(afterCursor) || 0);
    if (cursor > threshold) return Promise.resolve({ cursor, session: ptyManager.get(owner.ptyId) });
    return new Promise((resolve, reject) => {
      const waiter = {
        expectedIncarnationId: owner.incarnationId,
        expectedGeneration: owner.generation,
        afterCursor: threshold,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        removeInputRenderWaiter(owner.workspaceSessionId, waiter);
        // A lack of visible output is not evidence that the paste was rejected:
        // the resumed OpenCode session view can keep its composer off-screen.
        // This bounded delay is solely a transport fence for the TUI's async
        // paste event; exit and incarnation mismatches still reject.
        resolve({ cursor: threshold, rendered: false });
      }, Math.max(1, Number(settleTimeoutMs) || DEFAULT_INTERACTIVE_INPUT_SETTLE_TIMEOUT_MS));
      timer.unref?.();
      const waiters = inputRenderWaiters.get(owner.workspaceSessionId) ?? [];
      waiters.push(waiter);
      inputRenderWaiters.set(owner.workspaceSessionId, waiters);
    });
  }

  function settleInteractiveTuiWaiters(workspaceSessionId, value) {
    const waiters = interactiveReadyWaiters.get(workspaceSessionId) ?? [];
    interactiveReadyWaiters.delete(workspaceSessionId);
    for (const waiter of waiters) {
      if (waiter.expectedIncarnationId === value.incarnationId && waiter.expectedGeneration === value.generation) {
        waiter.resolve(value.session);
      } else {
        waiter.reject(new Error("terminal_incarnation_stale"));
      }
    }
  }

  function rejectInteractiveTuiWaiters(workspaceSessionId, error) {
    const waiters = interactiveReadyWaiters.get(workspaceSessionId) ?? [];
    interactiveReadyWaiters.delete(workspaceSessionId);
    for (const waiter of waiters) waiter.reject(error);
  }

  function settleTerminalExitWaiters(workspaceSessionId, owner) {
    const waiters = terminalExitWaiters.get(workspaceSessionId) ?? [];
    terminalExitWaiters.delete(workspaceSessionId);
    for (const waiter of waiters) {
      if (waiter.expectedIncarnationId === owner?.incarnationId && waiter.expectedGeneration === owner?.generation) waiter.resolve(publicOwner(owner));
      else waiter.reject(new Error("terminal_incarnation_stale"));
    }
  }

  function removeTerminalExitWaiter(workspaceSessionId, waiter) {
    const waiters = terminalExitWaiters.get(workspaceSessionId) ?? [];
    const remaining = waiters.filter((candidate) => candidate !== waiter);
    if (remaining.length) terminalExitWaiters.set(workspaceSessionId, remaining);
    else terminalExitWaiters.delete(workspaceSessionId);
  }

  function settleInputRenderWaiters(workspaceSessionId, value) {
    const waiters = inputRenderWaiters.get(workspaceSessionId) ?? [];
    const remaining = [];
    for (const waiter of waiters) {
      if (waiter.expectedIncarnationId !== value.incarnationId || waiter.expectedGeneration !== value.generation) {
        waiter.reject(new Error("terminal_incarnation_stale"));
      } else if (value.cursor > waiter.afterCursor) {
        waiter.resolve({ cursor: value.cursor, session: ptyManager.get(workspaceSessionId) });
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length) inputRenderWaiters.set(workspaceSessionId, remaining);
    else inputRenderWaiters.delete(workspaceSessionId);
  }

  function rejectInputRenderWaiters(workspaceSessionId, error) {
    const waiters = inputRenderWaiters.get(workspaceSessionId) ?? [];
    inputRenderWaiters.delete(workspaceSessionId);
    for (const waiter of waiters) waiter.reject(error);
  }

  function removeInputRenderWaiter(workspaceSessionId, waiter) {
    const waiters = inputRenderWaiters.get(workspaceSessionId) ?? [];
    const remaining = waiters.filter((candidate) => candidate !== waiter);
    if (remaining.length) inputRenderWaiters.set(workspaceSessionId, remaining);
    else inputRenderWaiters.delete(workspaceSessionId);
  }

  function removeInteractiveTuiWaiter(workspaceSessionId, waiter) {
    const waiters = interactiveReadyWaiters.get(workspaceSessionId) ?? [];
    const remaining = waiters.filter((candidate) => candidate !== waiter);
    if (remaining.length) interactiveReadyWaiters.set(workspaceSessionId, remaining);
    else interactiveReadyWaiters.delete(workspaceSessionId);
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

  // A logical Session can outlive many local PTYs.  Dispatch cancellation is
  // scoped to the PTY incarnation that accepted its input, so keeping only
  // the current owner would let a later permission-recovery terminal erase the
  // exit fact required to settle an older Dispatch safely.
  function ownerForIncarnation({ workspaceSessionId, incarnationId, generation }) {
    const row = db.prepare(
      `SELECT * FROM terminal_session_incarnations
       WHERE workspace_session_id = ? AND incarnation_id = ? AND generation = ?`,
    ).get(workspaceSessionId, incarnationId, generation);
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
    db.prepare(
      `INSERT INTO terminal_session_incarnations
        (workspace_session_id, incarnation_id, generation, task_id, pty_id, fingerprint, state, details_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_session_id, incarnation_id, generation) DO UPDATE SET
         task_id = excluded.task_id,
         pty_id = excluded.pty_id,
         fingerprint = excluded.fingerprint,
         state = excluded.state,
         details_json = excluded.details_json,
         updated_at = excluded.updated_at`,
    ).run(
      owner.workspaceSessionId,
      owner.incarnationId,
      owner.generation,
      owner.taskId,
      owner.ptyId,
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
    const closed = new Error("session_authority_closed");
    for (const [workspaceSessionId] of terminalExitWaiters) {
      const waiters = terminalExitWaiters.get(workspaceSessionId) ?? [];
      for (const waiter of waiters) waiter.reject(closed);
    }
    terminalExitWaiters.clear();
    for (const [workspaceSessionId] of inputRenderWaiters) rejectInputRenderWaiters(workspaceSessionId, closed);
    db.close();
  }

  return {
    registerLaunchProfile,
    activateSession,
    enqueueInput,
    enqueueInteractiveSubmission,
    stopSession,
    releaseTask,
    resizeSession,
    readSession,
    readSessionOwner,
    resolveLiveOwner,
    waitForInteractiveTui,
    waitForTerminalExit,
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
    interactiveReadyQuietMs: Number.isFinite(Number(input?.interactiveReadyQuietMs))
      ? Number(input.interactiveReadyQuietMs)
      : undefined,
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
    stoppedAt: owner.stoppedAt,
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

function optionalString(value) {
  return String(value ?? "").trim();
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

    CREATE TABLE IF NOT EXISTS terminal_session_incarnations (
      workspace_session_id TEXT NOT NULL,
      incarnation_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      task_id TEXT NOT NULL,
      pty_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      state TEXT NOT NULL,
      details_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_session_id, incarnation_id, generation)
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
