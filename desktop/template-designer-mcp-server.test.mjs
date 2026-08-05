import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createBridgeClientFromEnv,
  handleMcpMessage,
  handleStdioLine,
  tools,
  validateToolArguments,
} = require("./template-designer-mcp-server.cjs");

test("Template Designer MCP exposes only Draft read and patch tools", async () => {
  assert.deepEqual(tools.map((tool) => tool.name), ["read_draft", "apply_patch"]);
  const listed = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["read_draft", "apply_patch"]);
  assert.deepEqual(tools[0].inputSchema.properties, {}, "the model cannot choose a Draft or capability");
  assert.deepEqual(tools[0].inputSchema.required, []);
  assert.equal(Object.hasOwn(tools[1].inputSchema.properties, "providerSessionId"), false);
  assert.equal(Object.hasOwn(tools[1].inputSchema.properties, "capabilitySecret"), false);
  assert.equal(validateToolArguments("save_template", {}).ok, false);
  assert.equal(validateToolArguments("read_draft", {}).ok, false, "the plugin must inject the provider Session id before the MCP child runs");
  assert.equal(validateToolArguments("read_draft", { providerSessionId: "ses_design001" }).ok, true);
});

test("Template Designer MCP forwards valid revisioned patch and returns validation errors in MCP form", async () => {
  const calls = [];
  const client = { callTool: async (name, args) => { calls.push({ name, args }); return { draft: { draftId: "draft_1", revision: 4 } }; } };
  const valid = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "apply_patch",
      arguments: { providerSessionId: "ses_design001", expectedRevision: 3, operationId: "op_4", patch: [{ op: "replace", path: "/name", value: "Refined" }] },
    },
  }, client);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "apply_patch");
  assert.match(valid.result.content[0].text, /draft_1/);

  const invalid = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "apply_patch", arguments: { providerSessionId: "ses_design001", expectedRevision: 3, operationId: "op_5", patch: [] } },
  }, client);
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /apply_patch_requires/);
});

test("Template Designer MCP keeps JSON-RPC parse errors, notifications, and argument boundaries explicit", async () => {
  const calls = [];
  const client = { callTool: async (name, args) => { calls.push({ name, args }); return { providerSessionId: args.providerSessionId }; } };
  const malformed = await handleStdioLine("not-json", client);
  assert.deepEqual(malformed, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });

  const invalidRequest = await handleMcpMessage({ id: 1, method: "tools/list" }, client);
  assert.deepEqual(invalidRequest, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });

  const notification = await handleMcpMessage({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "read_draft", arguments: { providerSessionId: "ses_design001" } },
  }, client);
  assert.equal(notification, undefined);
  assert.deepEqual(calls, [{ name: "read_draft", args: { providerSessionId: "ses_design001" } }]);

  assert.equal(validateToolArguments("read_draft", { providerSessionId: "ses_design001", ignored: true }).ok, false);
  assert.equal(validateToolArguments("apply_patch", {
    providerSessionId: "ses_design001",
    expectedRevision: 1,
    operationId: "op_1",
    patch: [{ op: "replace", path: "/name", value: "Next", ignored: true }],
  }).ok, false);
});

test("Template Designer MCP uses the host-config bridge environment and only calls loopback endpoints", async () => {
  const calls = [];
  const client = createBridgeClientFromEnv({
    env: {
      AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL: "http://127.0.0.1:4567",
      AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN: "template-token",
      AGENT_WORKSPACE_TEMPLATE_DESIGN_BRIDGE_URL: "http://example.invalid",
      AGENT_WORKSPACE_TEMPLATE_DESIGN_BRIDGE_TOKEN: "old-token",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ draftId: "draft_1" }), { status: 200 });
    },
  });
  assert.deepEqual(await client.callTool("read_draft", { providerSessionId: "ses_design001" }), { draftId: "draft_1" });
  assert.equal(calls[0].url, "http://127.0.0.1:4567/tools/read_draft");
  assert.equal(calls[0].init.headers.authorization, "Bearer template-token");

  const invalidClient = createBridgeClientFromEnv({
    env: {
      AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL: "https://example.com",
      AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN: "template-token",
    },
  });
  await assert.rejects(() => invalidClient.callTool("read_draft", { providerSessionId: "ses_design001" }), /template_design_tool_bridge_url_invalid/);
});
