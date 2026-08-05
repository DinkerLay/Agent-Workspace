import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpenCodeServerManager, parseOpenCodeSse } = require("./server-manager.cjs");
const { test } = await import("node:test");

test("starts one loopback headless OpenCode Server for a Task Run and stops it after its last reference", async () => {
  const spawnCalls = [];
  const child = new EventEmitter();
  child.pid = 44111;
  child.kill = (signal) => { child.killedWith = signal; return true; };
  const manager = createOpenCodeServerManager({
    opencodePath: "/mock/opencode",
    spawn: (...args) => { spawnCalls.push(args); return child; },
    reservePort: async () => 43111,
    expectedProviderVersion: "1.18.11",
    idleShutdownMs: 0,
    wait: async () => undefined,
    fetchImpl: async (url) => url.endsWith("/global/health")
      ? response({ healthy: true, version: "1.18.11" })
      : response({ openapi: "3.1.0" }),
  });
  const server = await manager.ensureRun({ taskId: "task-1", runId: "run-1", cwd: "/tmp/agent-workspace-server-manager", config: { content: { agent: {} } } });
  assert.deepEqual(server, {
    taskId: "task-1",
    runId: "run-1",
    cwd: fs.realpathSync("/tmp/agent-workspace-server-manager"),
    origin: "http://127.0.0.1:43111",
    pid: 44111,
    providerVersion: "1.18.11",
    openApiSchemaVersion: "3.1.0",
  });
  assert.deepEqual(spawnCalls[0][1], ["serve", "--hostname", "127.0.0.1", "--port", "43111"]);
  assert.equal(spawnCalls[0][2].stdio, "ignore");
  assert.equal(spawnCalls[0][2].env.OPENCODE_CONFIG_CONTENT, JSON.stringify({ agent: {} }));
  assert.equal(await manager.stopRun({ taskId: "task-1", runId: "run-1" }), true);
  assert.equal(child.killedWith, "SIGTERM");
});

test("shares one OpenCode Server host between active Task Runs at the same canonical project root", async () => {
  const spawnCalls = [];
  const child = childProcess({ pid: 44222 });
  const manager = createOpenCodeServerManager({
    opencodePath: "/mock/opencode",
    spawn: (...args) => { spawnCalls.push(args); return child; },
    reservePort: async () => 43222,
    expectedProviderVersion: "1.18.11",
    idleShutdownMs: 0,
    wait: async () => undefined,
    fetchImpl: healthyFetch,
  });

  const first = await manager.ensureRun({
    taskId: "task-1",
    runId: "run-1",
    cwd: "/tmp/agent-workspace-server-manager/shared/..",
    config: { content: { agent: {} } },
  });
  const second = await manager.ensureRun({
    taskId: "task-2",
    runId: "run-2",
    cwd: "/tmp/agent-workspace-server-manager",
    config: { content: { agent: {} } },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(first.origin, second.origin);
  assert.equal(first.pid, second.pid);
  assert.notEqual(first.runId, second.runId);
  assert.equal(manager.clientForRun({ taskId: "task-1", runId: "run-1" }), manager.clientForRun({ taskId: "task-2", runId: "run-2" }));

  assert.equal(await manager.stopRun({ taskId: "task-1", runId: "run-1" }), true);
  assert.equal(child.killedWith, undefined);
  assert.equal(manager.getRun({ taskId: "task-1", runId: "run-1" }), undefined);
  assert.equal(manager.getRun({ taskId: "task-2", runId: "run-2" })?.origin, first.origin);

  assert.equal(await manager.stopRun({ taskId: "task-2", runId: "run-2" }), true);
  assert.equal(child.killedWith, "SIGTERM");
});

test("shares a canonical-cwd Host between a Task Run and a Template Design owner while keeping their leases isolated", async () => {
  const spawnCalls = [];
  const child = childProcess({ pid: 44225 });
  const manager = createOpenCodeServerManager({
    opencodePath: "/mock/opencode",
    spawn: (...args) => { spawnCalls.push(args); return child; },
    reservePort: async () => 43225,
    expectedProviderVersion: "1.18.11",
    idleShutdownMs: 0,
    wait: async () => undefined,
    fetchImpl: healthyFetch,
  });
  const config = { content: { agent: {} } };

  const taskServer = await manager.ensureRun({
    taskId: "task-1",
    runId: "run-1",
    cwd: "/tmp/agent-workspace-server-manager/shared/..",
    config,
    leaseId: "task-runtime",
  });
  const designServer = await manager.ensureOwner({
    ownerId: "template-design:draft-1",
    cwd: "/tmp/agent-workspace-server-manager",
    config,
    leaseId: "design-presentation",
  });
  await manager.ensureOwner({
    ownerId: "template-design:draft-1",
    cwd: "/tmp/agent-workspace-server-manager",
    config,
    leaseId: "design-activity",
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(designServer.ownerId, "template-design:draft-1");
  assert.equal(designServer.origin, taskServer.origin);
  assert.equal(designServer.pid, taskServer.pid);
  assert.equal(
    manager.clientForOwner({ ownerId: "template-design:draft-1" }),
    manager.clientForRun({ taskId: "task-1", runId: "run-1" }),
  );

  assert.equal(await manager.releaseOwner({ ownerId: "template-design:draft-1", leaseId: "design-presentation" }), true);
  assert.ok(manager.getOwner({ ownerId: "template-design:draft-1" }), "the owner's second lease keeps its binding live");
  assert.equal(child.killedWith, undefined);

  assert.equal(await manager.releaseOwner({ ownerId: "template-design:draft-1", leaseId: "design-activity" }), true);
  assert.equal(manager.getOwner({ ownerId: "template-design:draft-1" }), undefined);
  assert.ok(manager.getRun({ taskId: "task-1", runId: "run-1" }), "releasing a design owner must not release the Task Run owner");
  assert.equal(child.killedWith, undefined);

  assert.equal(await manager.releaseRun({ taskId: "task-1", runId: "run-1", leaseId: "task-runtime" }), true);
  assert.equal(child.killedWith, "SIGTERM");
});

test("cancels bounded idle shutdown when another Task Run reattaches to the shared host", async () => {
  const child = childProcess({ pid: 44223 });
  const timers = [];
  const manager = createOpenCodeServerManager({
    opencodePath: "/mock/opencode",
    spawn: () => child,
    reservePort: async () => 43223,
    expectedProviderVersion: "1.18.11",
    idleShutdownMs: 30_000,
    setTimer: (callback, timeoutMs) => {
      const timer = { callback, timeoutMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
    wait: async () => undefined,
    fetchImpl: healthyFetch,
  });

  await manager.ensureRun({ taskId: "task-1", runId: "run-1", cwd: "/tmp/agent-workspace-server-manager", config: { content: { agent: {} } } });
  await manager.stopRun({ taskId: "task-1", runId: "run-1" });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].timeoutMs, 30_000);
  assert.equal(child.killedWith, undefined);

  await manager.ensureRun({ taskId: "task-2", runId: "run-2", cwd: "/tmp/agent-workspace-server-manager", config: { content: { agent: {} } } });
  assert.equal(timers[0].cancelled, true);
  assert.equal(child.killedWith, undefined);

  await manager.stopRun({ taskId: "task-2", runId: "run-2" });
  timers[1].callback();
  assert.equal(child.killedWith, "SIGTERM");
});

test("keeps a shared Host alive until the final Run presentation lease is released", async () => {
  const child = childProcess({ pid: 44224 });
  const manager = createOpenCodeServerManager({
    opencodePath: "/mock/opencode",
    spawn: () => child,
    reservePort: async () => 43224,
    expectedProviderVersion: "1.18.11",
    idleShutdownMs: 0,
    wait: async () => undefined,
    fetchImpl: healthyFetch,
  });

  await manager.ensureRun({ taskId: "task-1", runId: "run-1", cwd: "/tmp/agent-workspace-server-manager", config: { content: { agent: {} } }, leaseId: "presentation-a" });
  await manager.ensureRun({ taskId: "task-1", runId: "run-1", cwd: "/tmp/agent-workspace-server-manager", config: { content: { agent: {} } }, leaseId: "presentation-b" });
  assert.equal(await manager.releaseRun({ taskId: "task-1", runId: "run-1", leaseId: "presentation-a" }), true);
  assert.equal(child.killedWith, undefined);
  assert.ok(manager.getRun({ taskId: "task-1", runId: "run-1" }));
  assert.equal(await manager.releaseRun({ taskId: "task-1", runId: "run-1", leaseId: "presentation-b" }), true);
  assert.equal(child.killedWith, "SIGTERM");
});

test("binds a Run presentation lease to that Run's canonical Host directory", async () => {
  const registrations = [];
  const child = childProcess({ pid: 44226 });
  const manager = createOpenCodeServerManager({
    opencodePath: "/mock/opencode",
    spawn: () => child,
    reservePort: async () => 43226,
    expectedProviderVersion: "1.18.11",
    idleShutdownMs: 0,
    wait: async () => undefined,
    fetchImpl: healthyFetch,
    createPresentationGateway: () => ({
      async registerPresentation(input) {
        registrations.push(input);
        return { origin: "http://127.0.0.1:4999", pathPrefix: "/_agent-workspace/presentation/lease" };
      },
      async releasePresentation() { return true; },
      async close() { return true; },
    }),
  });
  const cwd = fs.realpathSync("/tmp/agent-workspace-server-manager");
  await manager.ensureRun({
    taskId: "task-presentation",
    runId: "run-presentation",
    cwd,
    config: { content: { agent: {} } },
    leaseId: "presentation-lease",
  });

  await manager.registerRunPresentationGateway({
    taskId: "task-presentation",
    runId: "run-presentation",
    leaseId: "presentation-lease",
    providerSessionId: "ses_conductor",
    cwd: `${cwd}/.`,
    beforeProviderUserMessage: async () => undefined,
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].ownerId, "task-run:task-presentation:run-presentation");
  assert.equal(registrations[0].leaseId, "presentation-lease");
  assert.equal(registrations[0].providerSessionId, "ses_conductor");
  assert.equal(registrations[0].cwd, cwd);
  assert.equal(typeof registrations[0].beforeProviderUserMessage, "function");

  await assert.rejects(
    manager.registerRunPresentationGateway({
      taskId: "task-presentation",
      runId: "run-presentation",
      leaseId: "presentation-lease",
      providerSessionId: "ses_conductor",
      cwd: "/private/tmp/another-presentation-project",
      beforeProviderUserMessage: async () => undefined,
    }),
    /opencode_server_presentation_cwd_conflict/,
  );
  assert.equal(registrations.length, 1, "a rejected cross-directory lease must not reach the gateway");
  await manager.stopAll();
});

test("isolates OpenCode Server hosts for different project roots", async () => {
  const spawnCalls = [];
  let childPid = 44300;
  let port = 43300;
  const manager = createOpenCodeServerManager({
    opencodePath: "/mock/opencode",
    spawn: (...args) => {
      spawnCalls.push(args);
      return childProcess({ pid: childPid++ });
    },
    reservePort: async () => port++,
    expectedProviderVersion: "1.18.11",
    idleShutdownMs: 0,
    wait: async () => undefined,
    fetchImpl: healthyFetch,
  });

  const first = await manager.ensureRun({ taskId: "task-1", runId: "run-1", cwd: "/tmp/agent-workspace-project-a", config: { content: { agent: {} } } });
  const second = await manager.ensureRun({ taskId: "task-2", runId: "run-2", cwd: "/tmp/agent-workspace-project-b", config: { content: { agent: {} } } });

  assert.equal(spawnCalls.length, 2);
  assert.notEqual(first.origin, second.origin);
  await manager.stopAll();
});

test("parses split OpenCode Server SSE frames without exposing transport details", async () => {
  const events = [];
  await parseOpenCodeSse(chunks([
    "data: {\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_1\"}}\n",
    "\ndata: {\"type\":\"session.idle\",\"properties\":{\"sessionID\":\"ses_1\"}}\n\n",
  ]), (event) => events.push(event));
  assert.deepEqual(events, [
    { type: "session.status", properties: { sessionID: "ses_1" } },
    { type: "session.idle", properties: { sessionID: "ses_1" } },
  ]);
});

function response(body) { return { ok: true, status: 200, async json() { return body; } }; }
async function* chunks(values) { for (const value of values) yield new TextEncoder().encode(value); }
function childProcess({ pid }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kill = (signal) => { child.killedWith = signal; return true; };
  return child;
}
async function healthyFetch(url) {
  return url.endsWith("/global/health")
    ? response({ healthy: true, version: "1.18.11" })
    : response({ openapi: "3.1.0" });
}
