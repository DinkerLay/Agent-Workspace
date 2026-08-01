import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const isVitest = process.env.VITEST === "true" || process.env.VITEST_WORKER_ID !== undefined;
const test = isVitest ? (await import("vitest")).test : (await import("node:test")).default;

const require = createRequire(import.meta.url);
const { createRuntimeBridgeHttpServer } = require("./runtime-bridge-http.cjs");

test("Runtime Bridge HTTP rejects unauthenticated and unknown calls", async (t) => {
  const server = createRuntimeBridgeHttpServer({
    token: "test-token",
    handlers: {
      getRuntimeStatus: async () => ({ available: true }),
      readTask: async (input, context) => ({ taskId: input.taskId, clientId: context.clientId }),
    },
  });
  const address = await server.start();
  afterTest(t, () => server.close());

  await assert.rejects(
    requestJson(`${address.url}/v1/status`),
    (error) => error.status === 401 && error.body.error === "runtime_bridge_unauthorized",
  );
  await assert.rejects(
    requestJson(`${address.url}/v1/call`, { token: "test-token", body: { method: "notAllowed" }, clientId: "browser-client-1234" }),
    (error) => error.status === 404 && error.body.error === "runtime_bridge_method_not_found",
  );
  await assert.rejects(
    requestJson(`${address.url}/v1/call`, { token: "test-token", body: { method: "readTask", input: { taskId: "task-1" } } }),
    (error) => error.status === 400 && error.body.error === "runtime_bridge_client_required",
  );
});

test("Runtime Bridge HTTP forwards only allowlisted calls and targets SSE events", async (t) => {
  const disconnected = [];
  let resolveDisconnected;
  const disconnectObserved = new Promise((resolve) => { resolveDisconnected = resolve; });
  const server = createRuntimeBridgeHttpServer({
    token: "test-token",
    handlers: {
      getRuntimeStatus: async () => ({ available: true }),
      readTask: async (input, context) => ({ taskId: input.taskId, clientId: context.clientId }),
    },
  });
  const address = await server.start();
  afterTest(t, () => server.close());
  server.onClientDisconnected((clientId) => {
    disconnected.push(clientId);
    resolveDisconnected(clientId);
  });

  const call = await requestJson(`${address.url}/v1/call`, {
    token: "test-token",
    clientId: "browser-client-1234",
    body: { method: "readTask", input: { taskId: "task-1" } },
  });
  assert.deepEqual(call, { result: { taskId: "task-1", clientId: "browser-client-1234" } });

  const events = await openEvents(`${address.url}/v1/events?clientId=browser-client-1234`, "test-token");
  server.publish("terminal-client", { id: "session-1" }, { clientId: "other-client-1234" });
  server.publish("agent-loop-runtime", { runId: "run-1" }, { clientId: "browser-client-1234" });
  assert.match(await readEvent(events.response), /"channel":"agent-loop-runtime"/);
  events.request.destroy();
  assert.equal(await disconnectObserved, "browser-client-1234");
  assert.deepEqual(disconnected, ["browser-client-1234"]);
});

function afterTest(context, callback) {
  if (typeof context.onTestFinished === "function") context.onTestFinished(callback);
  else context.after(callback);
}

function requestJson(url, { token, body, clientId } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: body ? "POST" : "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(clientId ? { "x-agent-workspace-client": clientId } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        const value = text ? JSON.parse(text) : undefined;
        if (response.statusCode >= 400) {
          const error = new Error(value?.error);
          error.status = response.statusCode;
          error.body = value;
          reject(error);
          return;
        }
        resolve(value);
      });
    });
    request.on("error", reject);
    if (body) request.end(JSON.stringify(body));
    else request.end();
  });
}

function openEvents(url, token) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { authorization: `Bearer ${token}` } }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`SSE request failed: ${response.statusCode}`));
        return;
      }
      resolve({ request, response });
    });
    request.on("error", reject);
  });
}

function readEvent(response) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (!text.includes("data:")) return;
      response.off("data", onData);
      resolve(text);
    };
    response.on("data", onData);
    response.once("error", reject);
  });
}
