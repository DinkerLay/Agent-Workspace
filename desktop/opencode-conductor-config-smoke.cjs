const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const opencodePath = process.env.OPENCODE_PATH || "/opt/homebrew/bin/opencode";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-opencode-config-"));
const mcpServerPath = path.resolve(__dirname, "conductor-mcp-server.cjs");
const systemPromptPath = path.join(tempRoot, ".agent-workspace", "runtime", "task-smoke", "conductor", "system.md");
fs.mkdirSync(path.dirname(systemPromptPath), { recursive: true });
fs.writeFileSync(systemPromptPath, "You are the task owner Conductor for Agent Workspace.\n");

const inlineConfig = {
  $schema: "https://opencode.ai/config.json",
  instructions: [systemPromptPath],
  mcp: {
    agent_workspace_conductor: {
      type: "local",
      command: ["node", mcpServerPath],
      enabled: true,
      environment: {
        AGENT_WORKSPACE_TOOL_BRIDGE_URL: "http://127.0.0.1:9",
        AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN: "smoke-token",
      },
    },
  },
  agent: {
    agent_workspace_conductor: {
      description: "Control-plane Conductor smoke profile.",
      mode: "primary",
      permission: {
        "*": "deny",
        "agent_workspace_conductor_*": "allow",
        question: "allow",
      },
    },
  },
  default_agent: "agent_workspace_conductor",
};

assert.ok(fs.existsSync(mcpServerPath), "conductor MCP server must exist before running this smoke");
assert.ok(inlineConfig.instructions.includes(systemPromptPath));
assert.equal(inlineConfig.mcp.agent_workspace_conductor.type, "local");
assert.equal(inlineConfig.agent.agent_workspace_conductor.permission["*"], "deny");

const result = spawnSync(opencodePath, ["mcp", "list"], {
  cwd: tempRoot,
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
  },
  encoding: "utf8",
  timeout: 10_000,
});

assert.equal(result.status, 0, result.stderr || result.stdout);
assert.match(`${result.stdout}\n${result.stderr}`, /agent_workspace_conductor|MCP|mcp/i);
assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /failed/i);
console.log("opencode inline Conductor config smoke passed");
