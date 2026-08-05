const OPEN_CODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";
const { ensureTemplateDesignCapabilityPluginConfig } = require("./template-design-capability-plugin.cjs");
const OPEN_CODE_DEFAULT_AGENT = "build";
const CONDUCTOR_MCP_NAME = "agent_workspace_conductor";
const CONDUCTOR_AGENT_NAME = "agent_workspace_conductor";
const TEMPLATE_DESIGNER_TOOL_NAMESPACE = "agent_workspace_template_designer";
const TEMPLATE_DESIGNER_AGENT_NAME = "agent_workspace_template_designer";

// A named Host Agent is reserved for a stable Provider capability boundary.
// It must not contain a Task's mutable charter, cards, or delivery rules:
// those are supplied by the Task Runtime as per-Task system context.
const CONDUCTOR_SYSTEM_PROMPT = [
  "You are the named Agent Workspace Conductor Provider Agent. This is a fixed control-plane profile, not a generic Build Session.",
  "Its only Agent Workspace capability is the Conductor tool namespace; the Task charter, available Cards, and continuation state are supplied separately by the Task Runtime.",
  "Do not change Provider identity, model, or Task scope from this fixed profile.",
].join("\n\n");

const TEMPLATE_DESIGNER_SYSTEM_PROMPT = [
  "You are the Agent Workspace Template Designer. You modify only the mutable Template Design Draft named in the current conversation.",
  "The OpenCode Host binds this Session to exactly one active Draft at tool execution. Do not supply or request a Draft id, capability, or other hidden binding value.",
  "For a new Template, or one still named with a generic placeholder such as Untitled Agent Loop or Template Draft, turn the user's first concrete business brief into a concise, specific top-level Template name before or together with the first Card patch. Preserve a meaningful existing name unless the user asks to rename it.",
  "Before proposing or applying a change, call read_draft and use the returned Draft revision and canonical Card ids.",
  "Interpret @card-id mentions as an explicit Card selection. Resolve every mentioned id against the Draft; if a mention is unknown or ambiguous, ask the user instead of guessing.",
  "Apply a durable change only through apply_patch with the current expectedRevision and typed operations. Summarize the applied patch for the user.",
  "Do not save a Template Version, create or modify a Task or Run, dispatch an Agent, write project files, or use Agent Workspace Conductor tools.",
].join("\n\n");

/**
 * Produces the stable config for one canonical-cwd OpenCode Host. Task Runs and
 * Template Design Sessions use the same Host, while Session/request policies
 * decide which named tools a particular Provider Session can use.
 */
function createOpenCodeHostConfig({ conductorBridge, templateDesignerBridge } = {}) {
  const mcp = {};
  const tools = {};
  const agent = {};

  if (conductorBridge) {
    mcp[CONDUCTOR_MCP_NAME] = localMcpConfig({
      bridge: conductorBridge,
      mcpServerPath: "conductorMcpServerPath",
      bridgeUrl: "conductorToolBridgeUrl",
      bridgeToken: "conductorToolBridgeToken",
      urlEnvironment: "AGENT_WORKSPACE_TOOL_BRIDGE_URL",
      tokenEnvironment: "AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN",
      errorPrefix: "opencode_host_config_conductor",
    });
    // Loading the MCP process is not Session authority. A Conductor enables
    // this namespace through its named Provider Agent; ordinary build Sessions
    // never acquire it merely by sharing the Host.
    tools[`${CONDUCTOR_MCP_NAME}_*`] = false;
    agent[CONDUCTOR_AGENT_NAME] = {
      mode: "primary",
      description: "Owns an Agent Workspace Task control plane: durable state, scoped Session dispatch, wakeups, and delivery claims.",
      prompt: CONDUCTOR_SYSTEM_PROMPT,
      tools: {
        [`${CONDUCTOR_MCP_NAME}_*`]: true,
        [`${TEMPLATE_DESIGNER_TOOL_NAMESPACE}_*`]: false,
      },
      permission: {
        "*": "deny",
        [`${CONDUCTOR_MCP_NAME}_*`]: "allow",
        question: "allow",
      },
    };
  }

  if (templateDesignerBridge) {
    validateTemplateDesignerBridge(templateDesignerBridge);
    // These are custom plugin tools, not an MCP child. The dedicated primary
    // Agent opts in below; Task Sessions running `build` never acquire
    // Template-design capabilities merely by sharing this Host.
    tools[`${TEMPLATE_DESIGNER_TOOL_NAMESPACE}_*`] = false;
  }

  const config = {
    $schema: OPEN_CODE_CONFIG_SCHEMA,
    mcp,
    tools,
    default_agent: OPEN_CODE_DEFAULT_AGENT,
  };

  if (templateDesignerBridge) {
    agent[TEMPLATE_DESIGNER_AGENT_NAME] = {
      mode: "primary",
      description: "Edits an Agent Workspace Template Draft through its isolated Session-bound tools.",
      prompt: TEMPLATE_DESIGNER_SYSTEM_PROMPT,
      tools: {
        [`${CONDUCTOR_MCP_NAME}_*`]: false,
        [`${TEMPLATE_DESIGNER_TOOL_NAMESPACE}_*`]: true,
      },
      permission: {
        [`${CONDUCTOR_MCP_NAME}_*`]: "deny",
        [`${TEMPLATE_DESIGNER_TOOL_NAMESPACE}_*`]: "allow",
        bash: "deny",
        edit: "deny",
      },
    };
  }

  if (Object.keys(agent).length) config.agent = agent;

  return config;
}

/**
 * The pure config above is safe to inspect in tests and diagnostics: Conductor
 * MCP credential values are represented only as OpenCode environment references.
 * This wrapper supplies Template Designer credentials only to the Host process
 * for the custom plugin's loopback bridge calls; they are not written into the
 * config content. It also installs the Template Designer plugin overlay when
 * that capability is available. The overlay must receive the canonical project
 * cwd so owners that share one OpenCode Host share it.
 */
function createOpenCodeHostRuntimeConfig({ cwd, conductorBridge, templateDesignerBridge } = {}) {
  const content = createOpenCodeHostConfig({ conductorBridge, templateDesignerBridge });
  const environment = {};

  if (conductorBridge) {
    Object.assign(environment, bridgeRuntimeEnvironment({
      bridge: conductorBridge,
      bridgeUrl: "conductorToolBridgeUrl",
      bridgeToken: "conductorToolBridgeToken",
      urlEnvironment: "AGENT_WORKSPACE_TOOL_BRIDGE_URL",
      tokenEnvironment: "AGENT_WORKSPACE_TOOL_BRIDGE_TOKEN",
      errorPrefix: "opencode_host_runtime_conductor",
    }));
  }

  if (templateDesignerBridge) {
    Object.assign(environment, bridgeRuntimeEnvironment({
      bridge: templateDesignerBridge,
      bridgeUrl: "templateDesignerToolBridgeUrl",
      bridgeToken: "templateDesignerToolBridgeToken",
      urlEnvironment: "AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_URL",
      tokenEnvironment: "AGENT_WORKSPACE_TEMPLATE_DESIGNER_BRIDGE_TOKEN",
      errorPrefix: "opencode_host_runtime_template_designer",
    }));
    environment.OPENCODE_CONFIG_DIR = ensureTemplateDesignCapabilityPluginConfig({ cwd });
  }

  if (Object.keys(environment).length === 0) return { content };
  return {
    content,
    environment,
  };
}

function localMcpConfig({ bridge, mcpServerPath, bridgeUrl, bridgeToken, urlEnvironment, tokenEnvironment, errorPrefix }) {
  // Validate the actual bridge values while keeping them out of
  // OPENCODE_CONFIG_CONTENT. OpenCode resolves these references from the Host
  // process environment when it launches the local MCP child.
  requiredBridgeValue(bridge?.[bridgeUrl], `${errorPrefix}_bridge_url_required`);
  requiredBridgeValue(bridge?.[bridgeToken], `${errorPrefix}_bridge_token_required`);
  return {
    type: "local",
    command: ["node", requiredBridgeValue(bridge?.[mcpServerPath], `${errorPrefix}_mcp_server_path_required`)],
    enabled: true,
    environment: {
      [urlEnvironment]: environmentReference(urlEnvironment),
      [tokenEnvironment]: environmentReference(tokenEnvironment),
    },
  };
}

function validateTemplateDesignerBridge(bridge) {
  requiredBridgeValue(bridge?.templateDesignerToolBridgeUrl, "opencode_host_config_template_designer_bridge_url_required");
  requiredBridgeValue(bridge?.templateDesignerToolBridgeToken, "opencode_host_config_template_designer_bridge_token_required");
}

function bridgeRuntimeEnvironment({ bridge, bridgeUrl, bridgeToken, urlEnvironment, tokenEnvironment, errorPrefix }) {
  return {
    [urlEnvironment]: requiredBridgeValue(bridge?.[bridgeUrl], `${errorPrefix}_bridge_url_required`),
    [tokenEnvironment]: requiredBridgeValue(bridge?.[bridgeToken], `${errorPrefix}_bridge_token_required`),
  };
}

function environmentReference(name) {
  return `{env:${name}}`;
}

function requiredBridgeValue(value, reason) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(reason);
  return text;
}

module.exports = {
  CONDUCTOR_AGENT_NAME,
  CONDUCTOR_SYSTEM_PROMPT,
  OPEN_CODE_DEFAULT_AGENT,
  TEMPLATE_DESIGNER_AGENT_NAME,
  createOpenCodeHostConfig,
  createOpenCodeHostRuntimeConfig,
};
