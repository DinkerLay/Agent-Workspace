const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConductorToolBridge } = require("./conductor-tool-bridge.cjs");
const { createSessionStore } = require("./session-store.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-conductor-smoke-"));
  const sessionStore = createSessionStore({ root });
  const writes = [];
  const sessions = new Map();
  const ptyManager = {
    get: (id) => sessions.get(id),
    write: (id, text) => {
      writes.push({ id, text });
      sessionStore.recordOutput({ taskId: "task-smoke", sessionId: id }, text);
      return sessions.get(id);
    },
  };

  const bridge = createConductorToolBridge({
    sessionStore,
    ptyManager,
    startWorkerSession: async ({ taskId, sessionId }) => {
      const session = { id: sessionId, taskId, status: "running" };
      sessions.set(sessionId, session);
      sessionStore.startSession({
        taskId,
        sessionId,
        command: "opencode",
        cwd: root,
        provider: "opencode",
      });
      return session;
    },
  });

  const dispatch = await bridge.callSession({
    taskId: "task-smoke",
    toSessionId: "task-smoke-researcher",
    assignment: "Research the target topic and write durable notes.",
    expectedOutput: "research note path",
    contextRefs: ["docs/research/source.md"],
  });

  assert.equal(dispatch.status, "delivered");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, "task-smoke-researcher");
  assert.match(writes[0].text, /Research the target topic/);
  assert.doesNotMatch(writes[0].text, /Workspace Session Message/);

  const view = await bridge.readSession({
    taskId: "task-smoke",
    sessionId: "task-smoke-researcher",
    sinceCursor: 0,
    maxChars: 4_000,
  });

  assert.equal(view.sessionId, "task-smoke-researcher");
  assert.equal(view.cleanTranscriptTail, "");
  assert.equal(view.dispatches.length, 1);
  assert.match(view.dispatches[0].assignment, /Research the target topic/);
  assert.equal(view.dispatches[0].dispatchId, dispatch.dispatchId);
  assert.equal(view.dispatches[0].status, "delivered");
  assert.doesNotMatch(JSON.stringify(view), /Workspace Session Message/);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
