const readline = require("node:readline");

const tools = [
  {
    name: "read_draft",
    description: "Read the editable Template Design Draft bound to this OpenCode Session. It is not a saved Template Version and it never creates a Task. The Host supplies the private Draft binding.",
    inputSchema: objectSchema({}, []),
  },
  {
    name: "apply_patch",
    description: "Apply one reviewed JSON Patch to the editable Template Design Draft bound to this OpenCode Session. Supply the revision returned by read_draft and a new operationId. This tool cannot save a Template Version or create a Task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        operationId: { type: "string", minLength: 1 },
        patch: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["add", "replace", "remove"] },
              path: { type: "string", minLength: 2 },
              value: {},
            },
            required: ["op", "path"],
          },
        },
      },
      required: ["expectedRevision", "operationId", "patch"],
    },
  },
];

async function handleMcpMessage(message, bridgeClient = createBridgeClientFromEnv()) {
  const request = inspectJsonRpcRequest(message);
  if (!request.ok) return jsonRpcError(null, -32600, "Invalid Request");

  const respond = (body) => request.notification ? undefined : { jsonrpc: "2.0", id: request.id, ...body };
  if (message.method === "initialize") {
    return respond({
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-workspace-template-designer", version: "0.1.0" },
      },
    });
  }
  if (message.method === "tools/list") return respond({ result: { tools } });
  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const args = message.params?.arguments ?? {};
    const validation = validateToolArguments(name, args);
    if (!validation.ok) {
      return respond({ result: toolErrorResult(validation) });
    }
    try {
      const result = await bridgeClient.callTool(name, args);
      return respond({ result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      return respond({ result: toolErrorResult({ error: error instanceof Error ? error.message : "template_design_tool_failed" }) });
    }
  }
  return respond({ error: { code: -32601, message: `Unsupported method ${message.method}` } });
}

function createBridgeClientFromEnv({ env = process.env, fetchImpl = fetch } = {}) {
  const url = env.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL;
  const token = env.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN;
  return {
    async callTool(name, args) {
      if (!url || !token) throw new Error("template_design_tool_bridge_env_missing");
      const endpoint = bridgeToolEndpoint(url, name);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body?.error || `template_design_tool_bridge_http_${response.status}`));
      return body;
    },
  };
}

function validateToolArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "tool_arguments_must_be_object" };
  if (name === "read_draft") {
    if (!onlyKeys(args, ["providerSessionId"])) return { ok: false, error: "read_draft_arguments_invalid" };
    return validId(args.providerSessionId)
      ? { ok: true }
      : { ok: false, error: "providerSessionId_required" };
  }
  if (name === "apply_patch") {
    if (!onlyKeys(args, ["providerSessionId", "expectedRevision", "operationId", "patch"])) return { ok: false, error: "apply_patch_arguments_invalid" };
    if (!validId(args.providerSessionId) || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0 || !validId(args.operationId) || !Array.isArray(args.patch) || args.patch.length < 1 || args.patch.length > 64) {
      return { ok: false, error: "apply_patch_requires_draft_revision_operation_and_patch" };
    }
    if (args.patch.some((entry) => !validPatchOperation(entry))) return { ok: false, error: "apply_patch_operation_invalid" };
    return { ok: true };
  }
  return { ok: false, error: "tool_not_found" };
}

function validPatchOperation(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!onlyKeys(entry, entry.op === "remove" ? ["op", "path"] : ["op", "path", "value"])) return false;
  if (!["add", "replace", "remove"].includes(entry.op) || !nonEmptyString(entry.path) || !String(entry.path).startsWith("/")) return false;
  return entry.op === "remove" ? !Object.hasOwn(entry, "value") : Object.hasOwn(entry, "value");
}

function inspectJsonRpcRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || !nonEmptyString(message.method)) {
    return { ok: false };
  }
  const notification = !Object.hasOwn(message, "id");
  if (!notification && !validJsonRpcId(message.id)) return { ok: false };
  return { ok: true, notification, id: message.id };
}

function validJsonRpcId(value) {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolErrorResult(payload) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function bridgeToolEndpoint(value, name) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("template_design_tool_bridge_url_invalid");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("template_design_tool_bridge_url_invalid");
  }
  url.pathname = `/tools/${encodeURIComponent(name)}`;
  return url.toString();
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function objectSchema(properties, required) {
  return { type: "object", additionalProperties: false, properties, required };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

async function runStdio() {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const result = await handleStdioLine(line);
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

async function handleStdioLine(line, bridgeClient) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }
  try {
    return await handleMcpMessage(message, bridgeClient);
  } catch {
    return jsonRpcError(null, -32603, "Internal error");
  }
}

if (require.main === module) {
  runStdio().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  tools,
  handleMcpMessage,
  handleStdioLine,
  validateToolArguments,
  createBridgeClientFromEnv,
};
