const readline = require("node:readline");

const tools = [
  {
    name: "call_session",
    description: "Asynchronously send an assignment to a provider-native worker session.",
    inputSchema: objectSchema(["taskId", "toSessionId", "assignment"]),
  },
  {
    name: "read_task_state",
    description: "Read the task-level runtime summary, pending dispatch results, session states, and decision points.",
    inputSchema: objectSchema(["taskId"]),
  },
  {
    name: "read_session",
    description: "Read Shell-owned provider-extracted results and state for a session.",
    inputSchema: objectSchema(["taskId", "sessionId"]),
  },
  {
    name: "claim_task_completion",
    description: "Record a structured task completion claim after durable evidence and required review context support completion.",
    inputSchema: objectSchema(["taskId", "sessionId", "message"]),
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

function objectSchema(required) {
  return {
    type: "object",
    properties: {},
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
