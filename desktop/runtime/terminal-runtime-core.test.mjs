import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { createSessionAuthority } from "./session-authority.cjs";
import { createTerminalInputArbiter } from "./terminal-input-arbiter.cjs";
import { createTerminalOutputBuffer } from "./terminal-output-buffer.cjs";

function createFakePtyManager() {
  const sessions = new Map();
  const starts = [];
  const writes = [];
  return {
    starts,
    writes,
    start(input) {
      starts.push(input);
      const session = {
        id: input.id,
        taskId: input.taskId,
        status: "running",
        incarnationId: input.incarnationId,
        generation: input.generation,
      };
      sessions.set(input.id, session);
      return session;
    },
    get(id) {
      return sessions.get(id);
    },
    write(id, payload, options = {}) {
      const session = sessions.get(id);
      if (!session || session.status !== "running" || options.expectedIncarnationId !== session.incarnationId) {
        return undefined;
      }
      writes.push({ id, payload, options });
      return session;
    },
    resize(id, _size, options = {}) {
      const session = sessions.get(id);
      return session?.incarnationId === options.expectedIncarnationId ? session : undefined;
    },
    stop(id, options = {}) {
      const session = sessions.get(id);
      if (!session || session.incarnationId !== options.expectedIncarnationId) return undefined;
      session.status = "stopped";
      return session;
    },
  };
}

function profile(overrides = {}) {
  return {
    workspaceSessionId: "opencode:project:task:worker",
    taskId: "task-runtime-1",
    command: "opencode",
    args: ["--model", "test-model"],
    cwd: "/tmp/runtime-project",
    provider: "opencode",
    model: "test-model",
    ...overrides,
  };
}

describe("Orca-derived terminal runtime core", () => {
  it("uses one physical PTY when concurrent activation requests target one Session", async () => {
    const manager = createFakePtyManager();
    const authority = createSessionAuthority({ ptyManager: manager });
    authority.registerLaunchProfile(profile());

    const [first, second] = await Promise.all([
      authority.activateSession({ workspaceSessionId: profile().workspaceSessionId, operationId: "op-1" }),
      authority.activateSession({ workspaceSessionId: profile().workspaceSessionId, operationId: "op-2" }),
    ]);

    expect(manager.starts).toHaveLength(1);
    expect([first.disposition, second.disposition].sort()).toEqual(["adopted", "created"]);
    expect(first.owner.incarnationId).toBe(second.owner.incarnationId);
    authority.close();
  });

  it("replays a completed activation operation and rejects an operation id with a changed Session", async () => {
    const manager = createFakePtyManager();
    const authority = createSessionAuthority({ ptyManager: manager });
    authority.registerLaunchProfile(profile());

    const created = await authority.activateSession({ workspaceSessionId: profile().workspaceSessionId, operationId: "op-1" });
    const replayed = await authority.activateSession({ workspaceSessionId: profile().workspaceSessionId, operationId: "op-1" });

    expect(created.disposition).toBe("created");
    expect(replayed.disposition).toBe("replayed");
    expect(manager.starts).toHaveLength(1);
    await expect(
      authority.activateSession({ workspaceSessionId: "opencode:project:task:other", operationId: "op-1" }),
    ).rejects.toThrow("session_launch_profile_not_found");
    authority.close();
  });

  it("does not allow a stale PTY exit to retire the replacement incarnation", async () => {
    const manager = createFakePtyManager();
    const ids = ["incarnation-1", "generation-1", "incarnation-2", "generation-2"];
    const authority = createSessionAuthority({
      ptyManager: manager,
      randomUUID: () => ids.shift(),
    });
    authority.registerLaunchProfile(profile());
    const first = await authority.activateSession({ workspaceSessionId: profile().workspaceSessionId, operationId: "op-1" });
    authority.stopSession({ workspaceSessionId: profile().workspaceSessionId, expectedIncarnationId: first.owner.incarnationId });
    authority.handlePtyEvent({
      type: "exit",
      id: profile().workspaceSessionId,
      incarnationId: first.owner.incarnationId,
      generation: first.owner.generation,
      cursor: 0,
    });
    const second = await authority.activateSession({ workspaceSessionId: profile().workspaceSessionId, operationId: "op-2" });

    expect(second.owner.incarnationId).toBe("incarnation-2");
    expect(
      authority.handlePtyEvent({
        type: "exit",
        id: profile().workspaceSessionId,
        incarnationId: first.owner.incarnationId,
        generation: first.owner.generation,
        cursor: 0,
      }),
    ).toMatchObject({ accepted: false });
    expect(authority.resolveLiveOwner(profile().workspaceSessionId)).toMatchObject({
      incarnationId: "incarnation-2",
      state: "active",
    });
    authority.close();
  });

  it("replaces a stale active owner profile only after its physical PTY is gone", async () => {
    const manager = createFakePtyManager();
    const authority = createSessionAuthority({ ptyManager: manager });
    authority.registerLaunchProfile(profile());
    await authority.activateSession({ workspaceSessionId: profile().workspaceSessionId, operationId: "op-1" });

    // The durable owner says active, but Electron Main can no longer find a
    // physical terminal after a restart. A changed bridge/profile is safe to
    // register only in that proven-stale condition.
    manager.get(profile().workspaceSessionId).status = "stopped";
    expect(() => authority.registerLaunchProfile(profile({ args: ["--model", "new-bridge-profile"] }))).not.toThrow();
    const replacement = await authority.activateSession({ workspaceSessionId: profile().workspaceSessionId, operationId: "op-2" });
    expect(replacement.disposition).toBe("created");
    expect(manager.starts).toHaveLength(2);
    authority.close();
  });

  it("orders concurrent terminal input by source priority and rejects stale incarnation input", async () => {
    const writes = [];
    const owner = { status: "active", incarnationId: "incarnation-current" };
    const arbiter = createTerminalInputArbiter({
      resolveOwner: () => owner,
      write: ({ payload }) => writes.push(payload),
    });

    const dispatch = arbiter.enqueue({
      workspaceSessionId: "session-1",
      expectedIncarnationId: "incarnation-current",
      source: "dispatch",
      payload: "dispatch",
    });
    const user = arbiter.enqueue({
      workspaceSessionId: "session-1",
      expectedIncarnationId: "incarnation-current",
      source: "user",
      payload: "user",
    });
    await Promise.all([dispatch, user]);
    expect(writes).toEqual(["user", "dispatch"]);

    await expect(
      arbiter.enqueue({
        workspaceSessionId: "session-1",
        expectedIncarnationId: "old-incarnation",
        source: "user",
        payload: "must-not-write",
      }),
    ).rejects.toThrow("terminal_incarnation_stale");
    assert.deepEqual(writes, ["user", "dispatch"]);
  });

  it("routes input through the authority and rejects a stale physical owner", async () => {
    const manager = createFakePtyManager();
    const authority = createSessionAuthority({ ptyManager: manager });
    authority.registerLaunchProfile(profile());
    const activation = await authority.activateSession({
      workspaceSessionId: profile().workspaceSessionId,
      operationId: "op-input",
    });

    await authority.enqueueInput({
      workspaceSessionId: profile().workspaceSessionId,
      expectedIncarnationId: activation.owner.incarnationId,
      source: "dispatch",
      payload: "delegate this task\\n",
      idempotencyKey: "dispatch-1",
    });
    expect(manager.writes).toEqual([
      expect.objectContaining({
        id: profile().workspaceSessionId,
        payload: "delegate this task\\n",
        options: { expectedIncarnationId: activation.owner.incarnationId },
      }),
    ]);

    await expect(
      authority.enqueueInput({
        workspaceSessionId: profile().workspaceSessionId,
        expectedIncarnationId: "stale-incarnation",
        source: "user",
        payload: "must-not-reach-pty",
      }),
    ).rejects.toThrow("terminal_incarnation_stale");
    expect(manager.writes).toHaveLength(1);
    authority.close();
  });

  it("keeps byte-bounded output and signals a snapshot when the consumer cursor falls behind", () => {
    const buffer = createTerminalOutputBuffer({ maxBytes: 12 });
    buffer.append("first\n");
    buffer.append("中文中文\n");
    buffer.append("third\n");

    const snapshot = buffer.snapshot();
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(12);
    expect(snapshot.cursor).toBe(3);
    expect(buffer.readAfter(0)).toMatchObject({ requiresSnapshot: true, cursor: 3 });
    expect(buffer.readAfter(3)).toMatchObject({ requiresSnapshot: false, chunks: [] });
  });
});
