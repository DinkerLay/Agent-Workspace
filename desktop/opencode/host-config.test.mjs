import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createOpenCodeHostConfig, createOpenCodeHostRuntimeConfig } = require("./host-config.cjs");
const { test } = await import("node:test");

const conductorBridge = {
  conductorMcpServerPath: "/workspace/desktop/conductor-mcp-server.cjs",
  conductorToolBridgeUrl: "http://127.0.0.1:45111",
  conductorToolBridgeToken: "conductor-token",
};

const templateDesignerBridge = {
  templateDesignerToolBridgeUrl: "http://127.0.0.1:45112",
  templateDesignerToolBridgeToken: "template-designer-token",
};

test("creates one deterministic shared Host config with disabled-by-default MCP namespaces", () => {
  const config = createOpenCodeHostConfig({ conductorBridge, templateDesignerBridge });

  assert.deepEqual(config, createOpenCodeHostConfig({ conductorBridge, templateDesignerBridge }));
  assert.equal(config.$schema, "https://opencode.ai/config.json");
  assert.equal(config.default_agent, "build");
  assert.deepEqual(config.tools, {
    "agent_workspace_conductor_*": false,
    "agent_workspace_template_designer_*": false,
  });
  assert.deepEqual(config.mcp.agent_workspace_conductor, {
    type: "local",
    command: ["node", conductorBridge.conductorMcpServerPath],
    enabled: true,
    environment: {
      AGENT_WORKSPACE_TOOL_BRIDGE_URL: "{env:AGENT_WORKSPACE_TOOL_BRIDGE_URL}",
      AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN: "{env:AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN}",
    },
  });
  assert.equal(config.mcp.agent_workspace_template_designer, undefined, "Template Design uses Session-aware custom plugin tools, not an MCP child");

  assert.deepEqual(Object.keys(config.agent), ["agent_workspace_conductor", "agent_workspace_template_designer"]);
  const conductor = config.agent.agent_workspace_conductor;
  assert.equal(conductor.mode, "primary");
  assert.deepEqual(conductor.tools, {
    "agent_workspace_conductor_*": true,
    "agent_workspace_template_designer_*": false,
  });
  assert.deepEqual(conductor.permission, {
    "*": "deny",
    "agent_workspace_conductor_*": "allow",
    question: "allow",
  });
  assert.match(conductor.prompt, /fixed control-plane profile/);
  assert.match(conductor.prompt, /Task charter/);
  const designer = config.agent.agent_workspace_template_designer;
  assert.equal(designer.mode, "primary");
  assert.deepEqual(designer.tools, {
    "agent_workspace_conductor_*": false,
    "agent_workspace_template_designer_*": true,
  });
  assert.deepEqual(designer.permission, {
    "agent_workspace_conductor_*": "deny",
    "agent_workspace_template_designer_*": "allow",
    bash: "deny",
    edit: "deny",
  });
  assert.match(designer.prompt, /read_draft/);
  assert.match(designer.prompt, /@card-id/);
  assert.match(designer.prompt, /apply_patch/);
  assert.match(designer.prompt, /expectedRevision/);
  assert.match(designer.prompt, /Host binds this Session/);
  assert.match(designer.prompt, /top-level Template name/);
  assert.doesNotMatch(designer.prompt, /capabilitySecret/);
  assert.doesNotMatch(designer.prompt, /Draft id:\s*[A-Za-z0-9_-]+/);
  assert.match(designer.prompt, /Do not save a Template Version/);
  assert.doesNotMatch(JSON.stringify(config.agent), /searcher|reviewer|publisher/i);
  assert.doesNotMatch(JSON.stringify(config), /conductor-token|template-designer-token/);
});

test("adds the Template Design capability plugin only to the local Host environment", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workspace-host-config-"));
  try {
    const runtime = createOpenCodeHostRuntimeConfig({ cwd, conductorBridge, templateDesignerBridge });
    assert.deepEqual(runtime.content, createOpenCodeHostConfig({ conductorBridge, templateDesignerBridge }));
    assert.equal(runtime.environment.AGENT_WORKSPACE_TOOL_BRIDGE_URL, conductorBridge.conductorToolBridgeUrl);
    assert.equal(runtime.environment.AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN, conductorBridge.conductorToolBridgeToken);
    assert.equal(runtime.environment.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL, templateDesignerBridge.templateDesignerToolBridgeUrl);
    assert.equal(runtime.environment.AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN, templateDesignerBridge.templateDesignerToolBridgeToken);
    const plugin = path.join(runtime.environment.OPENCODE_CONFIG_DIR, "plugins", "agent-workspace-template-design-capability.js");
    assert.equal(fs.existsSync(plugin), true);
    const source = fs.readFileSync(plugin, "utf8");
    assert.doesNotMatch(source, /capabilitySecret/);
  assert.match(source, /tool: \{/);
  assert.match(source, /context\?\.sessionID/);
  assert.doesNotMatch(source, /tool\.execute\.before/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("keeps Build as the default while registering the dedicated Conductor Agent when no Template Designer bridge is installed", () => {
  const config = createOpenCodeHostConfig({ conductorBridge });

  assert.equal(config.default_agent, "build");
  assert.deepEqual(config.tools, { "agent_workspace_conductor_*": false });
  assert.ok(config.mcp.agent_workspace_conductor);
  assert.equal(config.mcp.agent_workspace_template_designer, undefined);
  assert.deepEqual(Object.keys(config.agent), ["agent_workspace_conductor"]);
  assert.equal(config.agent.agent_workspace_conductor.mode, "primary");

  const runtime = createOpenCodeHostRuntimeConfig({ cwd: "/workspace", conductorBridge });
  assert.deepEqual(runtime.content, config);
  assert.deepEqual(runtime.environment, {
    AGENT_WORKSPACE_TOOL_BRIDGE_URL: conductorBridge.conductorToolBridgeUrl,
    AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN: conductorBridge.conductorToolBridgeToken,
  });
});

test("rejects an incomplete bridge rather than producing a host config with unusable credentials", () => {
  assert.throws(
    () => createOpenCodeHostConfig({
      conductorBridge: { ...conductorBridge, conductorToolBridgeToken: "" },
    }),
    /opencode_host_config_conductor_bridge_token_required/,
  );
  assert.throws(
    () => createOpenCodeHostConfig({
      templateDesignerBridge: { ...templateDesignerBridge, templateDesignerToolBridgeUrl: "" },
    }),
    /opencode_host_config_template_designer_bridge_url_required/,
  );
});
