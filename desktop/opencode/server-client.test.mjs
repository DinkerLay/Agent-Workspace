import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpenCodeServerClient } = require("./server-client.cjs");

const tests = await import("node:test");
const { test } = tests;

test("uses the server API to create a bound Session and submit an async prompt", async () => {
  const calls = [];
  const client = createOpenCodeServerClient({
    serverOrigin: "http://127.0.0.1:4111",
    expectedProviderVersion: "1.18.11",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/global/health")) return response({ healthy: true, version: "1.18.11" });
      if (url.endsWith("/doc")) return response({ openapi: "3.1.0" });
      if (url.startsWith("http://127.0.0.1:4111/session?")) return response({ id: "ses_abc123" });
      if (url.includes("/prompt_async?")) return response(undefined, 204);
      if (url.includes("/session/ses_abc123/message?")) return response({ info: { id: "msg_turn123" }, parts: [] });
      if (url.includes("/session/ses_abc123?")) return response({ id: "ses_abc123", title: "Conductor" });
      if (url.includes("/permission/per_abc123/reply?")) return response(true);
      throw new Error(`unexpected_url:${url}`);
    },
  });

  assert.deepEqual(await client.health(), { providerVersion: "1.18.11", openApiSchemaVersion: "3.1.0" });
  const conductorPermission = [{ permission: "agent_workspace_conductor_*", pattern: "*", action: "allow" }];
  assert.equal((await client.createSession({ cwd: "/tmp/project", title: "Conductor", agent: "agent_workspace_conductor", model: "opencode-go/deepseek-v4-flash", permission: conductorPermission })).id, "ses_abc123");
  assert.deepEqual(await client.promptAsync({ cwd: "/tmp/project", providerSessionId: "ses_abc123", text: "Start", agent: "agent_workspace_conductor", model: "opencode-go/deepseek-v4-flash", tools: { "agent_workspace_conductor_*": true } }), { accepted: true, providerSessionId: "ses_abc123" });
  assert.deepEqual(await client.sendMessage({ cwd: "/tmp/project", providerSessionId: "ses_abc123", text: "Continue", agent: "agent_workspace_conductor", model: "opencode-go/deepseek-v4-flash", tools: { "agent_workspace_conductor_*": true } }), { accepted: true, providerSessionId: "ses_abc123", providerMessageId: "msg_turn123" });
  assert.deepEqual(await client.getSession({ cwd: "/tmp/project", providerSessionId: "ses_abc123" }), { id: "ses_abc123", title: "Conductor" });
  assert.deepEqual(JSON.parse(calls[2].options.body), { title: "Conductor", agent: "agent_workspace_conductor", model: { providerID: "opencode-go", id: "deepseek-v4-flash" }, permission: conductorPermission });
  assert.deepEqual(JSON.parse(calls[3].options.body), { agent: "agent_workspace_conductor", model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" }, tools: { "agent_workspace_conductor_*": true }, parts: [{ type: "text", text: "Start" }] });
  assert.deepEqual(JSON.parse(calls[4].options.body), { agent: "agent_workspace_conductor", model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" }, tools: { "agent_workspace_conductor_*": true }, parts: [{ type: "text", text: "Continue" }] });
  assert.match(calls[5].url, /\/session\/ses_abc123\?directory=/);
  assert.equal(await client.replyPermission({ cwd: "/tmp/project", requestId: "per_abc123", response: "once" }), true);
  assert.deepEqual(JSON.parse(calls[6].options.body), { reply: "once" });
});

test("keeps a provider-declared variant on Session creation and does not override it on later turns", async () => {
  const calls = [];
  const client = createOpenCodeServerClient({
    serverOrigin: "http://127.0.0.1:4111",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.startsWith("http://127.0.0.1:4111/session?")) return response({ id: "ses_variant1" });
      if (url.includes("/prompt_async?")) return response(undefined, 204);
      if (url.includes("/session/ses_variant1/message?")) return response({ info: { id: "msg_variant1" } });
      throw new Error(`unexpected_url:${url}`);
    },
  });
  const selected = {
    providerID: "opencode-go",
    modelID: "gpt-5.6-luna",
    variant: "max",
  };

  await client.createSession({ cwd: "/tmp/project", model: selected });
  await client.promptAsync({ cwd: "/tmp/project", providerSessionId: "ses_variant1", text: "Start", model: selected });
  await client.sendMessage({ cwd: "/tmp/project", providerSessionId: "ses_variant1", text: "Continue", model: selected });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: { providerID: "opencode-go", id: "gpt-5.6-luna", variant: "max" },
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    parts: [{ type: "text", text: "Start" }],
  });
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    parts: [{ type: "text", text: "Continue" }],
  });
});

test("uses an explicit async-prompt timeout for a cold Provider turn", async () => {
  const client = createOpenCodeServerClient({
    serverOrigin: "http://127.0.0.1:4111",
    requestTimeoutMs: 1_000,
    fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const startedAt = Date.now();
  await assert.rejects(
    client.promptAsync({ cwd: "/tmp/project", providerSessionId: "ses_abc123", text: "Start", timeoutMs: 5 }),
    /opencode_server_request_timeout/,
  );
  assert.ok(Date.now() - startedAt < 100, "the explicit async-prompt timeout must override the client default");
});

test("uses the Session-create cold-start timeout instead of the general control timeout", async () => {
  const client = createOpenCodeServerClient({
    serverOrigin: "http://127.0.0.1:4111",
    requestTimeoutMs: 1,
    sessionCreateTimeoutMs: 40,
    fetchImpl: async (_url, options = {}) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response({ id: "ses_coldstart" })), 12);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    }),
  });

  assert.equal((await client.createSession({ cwd: "/tmp/project" })).id, "ses_coldstart");
});

test("refuses a malformed Provider Session id before issuing a request", async () => {
  const client = createOpenCodeServerClient({ serverOrigin: "http://127.0.0.1:4111", fetchImpl: async () => { throw new Error("should_not_fetch"); } });
  await assert.rejects(client.promptAsync({ cwd: "/tmp/project", providerSessionId: "not-a-session", text: "Start" }), /opencode_server_session_id_invalid/);
  await assert.rejects(client.sendMessage({ cwd: "/tmp/project", providerSessionId: "not-a-session", text: "Continue" }), /opencode_server_session_id_invalid/);
  await assert.rejects(client.getSession({ cwd: "/tmp/project", providerSessionId: "not-a-session" }), /opencode_server_session_id_invalid/);
});

test("fails a hanging Server request instead of leaving a lifecycle command prepared", async () => {
  const client = createOpenCodeServerClient({
    serverOrigin: "http://127.0.0.1:4111",
    requestTimeoutMs: 5,
    sessionCreateTimeoutMs: 5,
    fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  await assert.rejects(client.createSession({ cwd: "/tmp/project" }), /opencode_server_request_timeout/);
});

test("uses an explicit Session-create timeout for a cold Provider host", async () => {
  const client = createOpenCodeServerClient({
    serverOrigin: "http://127.0.0.1:4111",
    requestTimeoutMs: 1_000,
    fetchImpl: async (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const startedAt = Date.now();
  await assert.rejects(client.createSession({ cwd: "/tmp/project", timeoutMs: 5 }), /opencode_server_request_timeout/);
  assert.ok(Date.now() - startedAt < 100, "the explicit Session-create timeout must override the client default");
});

function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }
