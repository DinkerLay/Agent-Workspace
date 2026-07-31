const readline = require("node:readline");

const tools = [
  {
    name: "call_session",
    description: "Asynchronously send an assignment to a provider-native worker session. To pass an exact completed Session result without rephrasing it, include contextRefs: [\"result:<resultId>\"] from read_task_state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        assignment: { type: "string", minLength: 1 },
        expectedOutput: { type: "string" },
        contextRefs: { type: "array", description: "Optional declared context. Use result:<resultId> to forward that exact Provider semantic answer into the target Session assignment.", items: { type: "string" } },
        priority: { type: "string", enum: ["low", "normal", "high"] },
      },
      required: ["taskId", "agentId", "assignment"],
    },
  },
  {
    name: "call_sessions",
    description: "Asynchronously send one independent, explicit assignment to each listed provider-native worker session. A worker may appear only once in a batch. Each dispatch may cite result:<resultId> to forward an exact completed Session result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        dispatches: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              agentId: { type: "string", minLength: 1 },
              assignment: { type: "string", minLength: 1 },
              expectedOutput: { type: "string" },
              contextRefs: { type: "array", description: "Use result:<resultId> to forward that exact Provider semantic answer.", items: { type: "string" } },
              priority: { type: "string", enum: ["low", "normal", "high"] },
            },
            required: ["agentId", "assignment"],
          },
        },
      },
      required: ["taskId", "dispatches"],
    },
  },
  {
    name: "read_task_state",
    description: "Read the task-level runtime summary, completed semantic results (including resultId), session states, and decision points. Cite result:<resultId> in a later dispatch when another Session needs the exact result.",
    inputSchema: objectSchema(["taskId"]),
  },
  {
    name: "cancel_dispatch",
    description: "Cancel one still-pending worker dispatch when continuing it is no longer useful. This explicitly stops that worker terminal and records the reason; it does not stop the Task or choose a replacement.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string", minLength: 1 },
        dispatchId: { type: "string", minLength: 1 },
        reason: { type: "string" },
      },
      required: ["taskId", "dispatchId"],
    },
  },
  {
    name: "read_session",
    description: "Read Shell-owned provider-extracted results and state for one approved Agent Card.",
    inputSchema: objectSchema(["taskId", "agentId"]),
  },
  {
    name: "claim_task_completion",
    description: "Record a user-visible delivery claim only after every explicit acceptance condition is satisfied by durable Provider results and declared artifact evidence. This is not a way to end, pause, or wait after a Conductor turn. The user, not a fake review gate, marks the Task achieved after inspecting the artifact.",
    inputSchema: objectSchema(["taskId", "message"]),
  },
];

async function handleMcpMessage(message, bridgeClient = createBridgeClientFromEnv()) {
  if (message.id === undefined || message.id === null) {
    return undefined;
  }

  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-workspace-conductor", version: "0.1.0" },
      },
    };
  }

  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id: message.id, result: { tools } };
  }

  if (message.method === "tools/call") {
    const name = String(message.params?.name ?? "");
    const args = message.params?.arguments ?? {};
    const validation = validateToolArguments(name, args);
    if (!validation.ok) {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { isError: true, content: [{ type: "text", text: JSON.stringify(validation) }] },
      };
    }
    const result = await bridgeClient.callTool(name, args);
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result) }],
      },
    };
  }

  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unsupported method ${message.method}` },
  };
}

function createBridgeClientFromEnv() {
  const url = process.env.AGENT_WORKSPACE_TOOL_BRIDGE_URL;
  const token = process.env.AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN;
  return {
    async callTool(name, args) {
      if (!url || !token) throw new Error("Agent Workspace tool bridge env is missing.");
      const response = await fetch(`${url}/tools/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args),
      });
      if (!response.ok) throw new Error(`Tool bridge request failed: ${response.status}`);
      return response.json();
    },
  };
}

function validateToolArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "tool_arguments_must_be_object" };
  if (name === "call_session") return validateDispatch(args);
  if (name === "call_sessions") {
    if (!nonEmptyString(args.taskId) || !Array.isArray(args.dispatches) || args.dispatches.length === 0) {
      return { ok: false, error: "call_sessions_requires_taskId_and_dispatches" };
    }
    const invalid = args.dispatches.find((item) => !validateDispatch({ ...item, taskId: args.taskId }).ok);
    return invalid ? { ok: false, error: "call_sessions_dispatch_invalid" } : { ok: true };
  }
  if (name === "read_task_state") return nonEmptyString(args.taskId) ? { ok: true } : { ok: false, error: "taskId_required" };
  if (name === "cancel_dispatch") return nonEmptyString(args.taskId) && nonEmptyString(args.dispatchId) && (args.reason === undefined || typeof args.reason === "string") ? { ok: true } : { ok: false, error: "cancel_dispatch_requires_taskId_dispatchId_and_optional_reason" };
  if (name === "read_session") return nonEmptyString(args.taskId) && nonEmptyString(args.agentId) ? { ok: true } : { ok: false, error: "taskId_and_agentId_required" };
  if (name === "claim_task_completion") return nonEmptyString(args.taskId) && nonEmptyString(args.message) ? { ok: true } : { ok: false, error: "taskId_and_message_required" };
  return { ok: false, error: "tool_not_found" };
}

function validateDispatch(args) {
  if (!nonEmptyString(args.taskId) || !nonEmptyString(args.agentId) || !nonEmptyString(args.assignment)) {
    return { ok: false, error: "dispatch_requires_taskId_agentId_assignment" };
  }
  if (args.contextRefs !== undefined && (!Array.isArray(args.contextRefs) || args.contextRefs.some((item) => typeof item !== "string"))) {
    return { ok: false, error: "dispatch_context_refs_invalid" };
  }
  if (args.expectedOutput !== undefined && typeof args.expectedOutput !== "string") return { ok: false, error: "dispatch_expected_output_invalid" };
  if (args.priority !== undefined && !["low", "normal", "high"].includes(args.priority)) return { ok: false, error: "dispatch_priority_invalid" };
  return { ok: true };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function objectSchema(required) {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(required.map((field) => [field, { type: "string", minLength: 1 }])),
    required,
  };
}

async function runStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const response = await handleMcpMessage(JSON.parse(line));
    if (response !== undefined) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (require.main === module) {
  runStdio().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { handleMcpMessage, tools };
